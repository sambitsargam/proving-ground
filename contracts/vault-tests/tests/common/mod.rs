#![allow(dead_code)]

use std::task::Poll;
use std::time::Duration;

use near_workspaces::network::Sandbox;
use near_workspaces::operations::{CallTransaction, TransactionStatus};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub type TestResult = Result<(), Box<dyn std::error::Error>>;
pub type Error = Box<dyn std::error::Error>;

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const FEE: u128 = NEAR / 100;
pub const DAY_NS: u64 = 86_400_000_000_000;
pub const PURPOSE: &str = "cd00000000000000000000000000000000000000000000000000000000000000";
pub const MAX_GAS: Gas = Gas::from_tgas(300);

pub fn near(amount: u128) -> u128 {
    amount * NEAR
}

pub fn invoice(n: u64) -> String {
    format!("{n:064x}")
}

pub fn allow(id: u64) -> String {
    verdict(id, "ALLOW", "WITHIN_PURPOSE")
}

pub fn warn(id: u64) -> String {
    verdict(id, "WARN", "UNCERTAIN")
}

pub fn block(id: u64) -> String {
    verdict(id, "BLOCK", "OUT_OF_PURPOSE")
}

pub fn verdict(id: u64, verdict: &str, reason: &str) -> String {
    json!({"v": 1, "request_id": id.to_string(), "verdict": verdict, "reasons": [reason]})
        .to_string()
}

fn wasm(name: &str) -> Result<Vec<u8>, Error> {
    let path = format!("{}/../../target/near/{name}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).map_err(|e| format!("{path}: {e}. Run `make contracts` first.").into())
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub vault: Contract,
    pub outlayer: Contract,
    pub owner: Account,
    pub agent: Account,
    pub vendor: Account,
    pub attacker: Account,
}

pub struct EnvOptions {
    pub check_timeout_ns: u64,
}

impl Default for EnvOptions {
    fn default() -> Self {
        Self { check_timeout_ns: DAY_NS }
    }
}

impl Env {
    pub async fn new() -> Result<Self, Error> {
        Self::with(EnvOptions::default()).await
    }

    pub async fn with(options: EnvOptions) -> Result<Self, Error> {
        let worker = near_workspaces::sandbox().await?;
        let outlayer = worker.dev_deploy(&wasm("mock_outlayer")?).await?;
        outlayer
            .call("new")
            .args_json(json!({"min_deposit": FEE.to_string()}))
            .transact()
            .await?
            .into_result()?;
        let vault = worker.dev_deploy(&wasm("provingground_vault")?).await?;
        vault
            .call("new")
            .args_json(json!({"checker": {
                "outlayer": outlayer.id(),
                "source": {"WasmUrl": {
                    "url": "https://test.fastfs.io/checker.wasm",
                    "hash": "aa".repeat(32),
                    "build_target": "wasm32-wasip2",
                }},
                "secrets_ref": null,
                "fee": FEE.to_string(),
                "max_instructions": "1000000000",
                "max_memory_mb": 128,
                "max_execution_seconds": "30",
                "check_timeout_ns": options.check_timeout_ns.to_string(),
            }}))
            .transact()
            .await?
            .into_result()?;
        let owner = worker.dev_create_account().await?;
        let agent = worker.dev_create_account().await?;
        let vendor = worker.dev_create_account().await?;
        let attacker = worker.dev_create_account().await?;
        Ok(Self { worker, vault, outlayer, owner, agent, vendor, attacker })
    }

    pub async fn now(&self) -> Result<u64, Error> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    pub fn mandate_args(&self, now: u64) -> Value {
        json!({
            "agent": self.agent.id(),
            "payees": [self.vendor.id()],
            "token": null,
            "max_total": near(10).to_string(),
            "max_per_payment": near(3).to_string(),
            "purpose_hash": PURPOSE,
            "expires_at": (now + DAY_NS).to_string(),
            "max_requests": 20,
            "max_checks_per_day": 20,
            "park_ttl": DAY_NS.to_string(),
            "checker_budget": near(1).to_string(),
        })
    }

    pub async fn set_cap(
        &self,
        owner: &Account,
        agent: &AccountId,
        cap: u128,
    ) -> Result<Value, Error> {
        let res = owner
            .call(self.vault.id(), "set_daily_cap")
            .args_json(json!({"agent": agent, "token": null, "cap": cap.to_string()}))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?;
        Ok(res.into_result()?.json()?)
    }

    /// Creates a mandate with a 20 NEAR cap and `funding` NEAR in it.
    pub async fn create(&self, args: Value, funding: u128) -> Result<u64, Error> {
        self.create_as(&self.owner, args, funding).await
    }

    pub async fn create_as(
        &self,
        owner: &Account,
        args: Value,
        funding: u128,
    ) -> Result<u64, Error> {
        let cap = self.set_cap(owner, &args["agent"].as_str().unwrap().parse()?, near(20)).await?;
        assert_eq!(cap["decision"], "OK");
        // Enough for storage and the checker budget. The surplus becomes funding,
        // which `fund` then tops up to the exact figure below.
        let deposit = near(1) + near(3);
        let res = owner
            .call(self.vault.id(), "create_mandate")
            .args_json(json!({"args": args}))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(MAX_GAS)
            .transact()
            .await?;
        let decision: Value = res.into_result()?.json()?;
        assert_eq!(decision["decision"], "OK", "{decision}");
        let id: u64 = decision["mandate_id"].as_str().unwrap().parse()?;
        let surplus = self.mandate(id).await?["balance"].as_str().unwrap().parse::<u128>()?;
        if surplus > 0 {
            self.withdraw_all(owner, id, surplus).await?;
        }
        if funding > 0 {
            owner
                .call(self.vault.id(), "fund")
                .args_json(json!({"mandate_id": id.to_string()}))
                .deposit(NearToken::from_yoctonear(funding))
                .transact()
                .await?
                .into_result()?;
        }
        Ok(id)
    }

    async fn withdraw_all(&self, owner: &Account, id: u64, amount: u128) -> Result<(), Error> {
        owner
            .call(self.vault.id(), "withdraw")
            .args_json(json!({"mandate_id": id.to_string(), "amount": amount.to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn standard(&self) -> Result<u64, Error> {
        let args = self.mandate_args(self.now().await?);
        self.create(args, near(10)).await
    }

    pub fn request_call(
        &self,
        agent: &Account,
        mandate: u64,
        payee: &str,
        amount: u128,
        invoice_hash: &str,
    ) -> CallTransaction {
        self.raw_request(
            agent,
            &mandate.to_string(),
            payee,
            &amount.to_string(),
            invoice_hash,
            "",
            "memo",
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn raw_request(
        &self,
        agent: &Account,
        mandate: &str,
        payee: &str,
        amount: &str,
        invoice_hash: &str,
        blob_ref: &str,
        memo: &str,
    ) -> CallTransaction {
        agent
            .call(self.vault.id(), "request_payment")
            .args_json(json!({
                "mandate_id": mandate,
                "payee": payee,
                "amount": amount,
                "invoice_hash": invoice_hash,
                "blob_ref": blob_ref,
                "memo": memo,
            }))
            .gas(MAX_GAS)
    }

    /// Sends a request expected to pass the contract rules, and waits until the
    /// mock checker holds it. Returns the in-flight transaction.
    pub async fn request_in_flight(
        &self,
        mandate: u64,
        amount: u128,
        invoice_hash: &str,
    ) -> Result<InFlight, Error> {
        let before = self.request_count().await?;
        let status = self
            .request_call(&self.agent, mandate, self.vendor.id().as_str(), amount, invoice_hash)
            .transact_async()
            .await?;
        let checker_id = before + 1;
        self.wait_for_call(checker_id).await?;
        Ok(InFlight { status, checker_id })
    }

    pub async fn wait_for_call(&self, checker_id: u64) -> Result<(), Error> {
        for _ in 0..120 {
            if self.request_count().await? >= checker_id {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("request never reached the checker".into())
    }

    pub async fn request_count(&self) -> Result<u64, Error> {
        Ok(self.outlayer.view("request_count").await?.json()?)
    }

    /// Hands the mock checker an output, then waits for the whole transaction.
    pub async fn resolve(&self, flight: InFlight, output: Option<String>) -> Result<Value, Error> {
        self.outlayer
            .call("resolve")
            .args_json(json!({"request_id": flight.checker_id, "output": output}))
            .gas(MAX_GAS)
            .transact()
            .await?
            .into_result()?;
        flight.finish().await
    }

    pub async fn mandate(&self, id: u64) -> Result<Value, Error> {
        Ok(self
            .vault
            .view("get_mandate")
            .args_json(json!({"mandate_id": id.to_string()}))
            .await?
            .json()?)
    }

    pub async fn request(&self, id: u64) -> Result<Value, Error> {
        Ok(self
            .vault
            .view("get_request")
            .args_json(json!({"request_id": id.to_string()}))
            .await?
            .json()?)
    }

    pub async fn balance(&self, id: &AccountId) -> Result<u128, Error> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    pub async fn owner_call(
        &self,
        caller: &Account,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> Result<Value, Error> {
        let res = caller
            .call(self.vault.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(MAX_GAS)
            .transact()
            .await?;
        Ok(res.into_result()?.json()?)
    }

    pub async fn approve(&self, caller: &Account, id: u64) -> Result<Value, Error> {
        self.owner_call(caller, "approve", json!({"request_id": id.to_string()}), 1).await
    }

    pub async fn reject(&self, caller: &Account, id: u64) -> Result<Value, Error> {
        self.owner_call(caller, "reject", json!({"request_id": id.to_string()}), 1).await
    }

    pub async fn revoke(&self, caller: &Account, id: u64) -> Result<Value, Error> {
        self.owner_call(caller, "revoke", json!({"mandate_id": id.to_string()}), 1).await
    }

    pub async fn assert_budget(
        &self,
        id: u64,
        balance: u128,
        reserved: u128,
        spent: u128,
    ) -> TestResult {
        let mandate = self.mandate(id).await?;
        assert_eq!(mandate["balance"], balance.to_string(), "balance");
        assert_eq!(mandate["reserved"], reserved.to_string(), "reserved");
        assert_eq!(mandate["spent"], spent.to_string(), "spent");
        Ok(())
    }
}

pub struct InFlight {
    pub status: TransactionStatus,
    pub checker_id: u64,
}

impl InFlight {
    pub async fn finish(self) -> Result<Value, Error> {
        for _ in 0..240 {
            if let Poll::Ready(result) = self.status.status().await? {
                return decision_of(result);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err("transaction never finished".into())
    }
}

pub fn decision_of(result: ExecutionFinalResult) -> Result<Value, Error> {
    Ok(result.into_result()?.json()?)
}

pub fn logs_of(result: &ExecutionFinalResult) -> Vec<String> {
    result.logs().iter().map(|log| log.to_string()).collect()
}

/// Events from a result's logs, filtered by event name.
pub fn events(result: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    logs_of(result)
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|event| event["event"] == name)
        .collect()
}
