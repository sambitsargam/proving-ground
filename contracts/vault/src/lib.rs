//! Vault that pays an agent's request only inside a mandate its owner signed.
//!
//! The rules live in `provingground-core`. This contract stores state, holds the
//! funds and talks to the checker. Rule failures return a reason code and never
//! panic, so every refusal leaves an event. See docs/MANDATES.md.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, log, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};
use provingground_core::{
    after_verdict, approve_check, day_of, evaluate, parse_checker_output, parse_hash, reject_check,
    stale_check, validate_new_mandate, CheckerOutcome, Ledger, Mandate, MandateStatus, NewMandate,
    Next, PaymentInput, PaymentRequest, PaymentStatus, Reason, Stale, Token, MAX_OUTPUT_LEN,
};

const ONE_YOCTO: u128 = 1;

/// Upper bounds on what one record stores, charged up front because the agent's
/// key cannot attach a deposit. A sandbox test asserts these hold.
const REQUEST_STORAGE_BYTES: u64 = 1_200;
const MANDATE_BASE_STORAGE_BYTES: u64 = 500;
const DAILY_CAP_STORAGE_BYTES: u64 = 300;

const GAS_REQUEST_EXECUTION: Gas = Gas::from_tgas(100);
const GAS_ON_VERDICT: Gas = Gas::from_tgas(60);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_ON_SETTLED: Gas = Gas::from_tgas(15);
const GAS_ON_RESTORE: Gas = Gas::from_tgas(10);
/// Enough for request_payment itself plus every stage it schedules. Anything less
/// could strand a request in `Checking`.
const MIN_REQUEST_GAS: Gas = Gas::from_tgas(180);
const MIN_APPROVE_GAS: Gas = Gas::from_tgas(60);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Mandates,
    Requests,
    MandateRequests,
    DailyCaps,
    DailyUsage,
    Invoices,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub enum CheckerSource {
    WasmUrl { url: String, hash: String, build_target: Option<String> },
    Project { project_id: String, version_key: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SecretsRef {
    pub profile: String,
    pub account_id: AccountId,
}

/// Fixed at deployment. There is no admin, so nothing can repoint the checker.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CheckerConfig {
    pub outlayer: AccountId,
    pub source: CheckerSource,
    pub secrets_ref: Option<SecretsRef>,
    pub fee: U128,
    pub max_instructions: U64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: U64,
    pub check_timeout_ns: U64,
}

#[near(serializers = [json])]
pub struct CreateMandateArgs {
    pub agent: String,
    pub payees: Vec<String>,
    /// NEP-141 contract, or none for native NEAR.
    pub token: Option<String>,
    pub max_total: String,
    pub max_per_payment: String,
    pub purpose_hash: String,
    pub expires_at: U64,
    pub max_requests: u32,
    pub max_checks_per_day: u32,
    pub park_ttl: U64,
    pub checker_budget: U128,
}

#[near(serializers = [json])]
pub struct Decision {
    pub decision: String,
    pub reason: String,
    pub mandate_id: Option<String>,
    pub request_id: Option<String>,
}

#[near(serializers = [json])]
pub struct MandateView {
    pub id: U64,
    pub owner: String,
    pub agent: String,
    pub payees: Vec<String>,
    pub token: Option<String>,
    pub max_total: U128,
    pub max_per_payment: U128,
    pub purpose_hash: String,
    pub expires_at: U64,
    pub max_requests: u32,
    pub max_checks_per_day: u32,
    pub park_ttl: U64,
    pub status: String,
    pub balance: U128,
    pub reserved: U128,
    pub spent: U128,
    pub checker_budget: U128,
    pub storage_balance: U128,
    pub requests_stored: u32,
}

#[near(serializers = [json])]
pub struct RequestView {
    pub id: U64,
    pub mandate_id: U64,
    pub payee: String,
    pub amount: U128,
    pub invoice_hash: String,
    pub blob_ref: String,
    pub memo: String,
    pub status: String,
    pub reason: String,
    pub created_at: U64,
    pub updated_at: U64,
}

#[near(serializers = [json])]
pub struct DailyStatus {
    pub cap: Option<U128>,
    pub used_today: U128,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    checker: CheckerConfig,
    next_mandate_id: u64,
    next_request_id: u64,
    mandates: LookupMap<u64, Mandate>,
    requests: LookupMap<u64, PaymentRequest>,
    mandate_requests: LookupMap<(u64, u32), u64>,
    daily_caps: LookupMap<[u8; 32], u128>,
    daily_usage: LookupMap<[u8; 32], (u64, u128)>,
    invoices: LookupSet<[u8; 32]>,
}

struct Book<'a> {
    daily_caps: &'a LookupMap<[u8; 32], u128>,
    daily_usage: &'a LookupMap<[u8; 32], (u64, u128)>,
    invoices: &'a LookupSet<[u8; 32]>,
}

impl Ledger for Book<'_> {
    fn daily_cap(&self, mandate: &Mandate) -> Option<u128> {
        self.daily_caps.get(&cap_key(&mandate.owner, &mandate.agent, &mandate.token)).copied()
    }

    fn daily_used(&self, mandate: &Mandate, day: u64) -> u128 {
        match self.daily_usage.get(&cap_key(&mandate.owner, &mandate.agent, &mandate.token)) {
            Some((used_day, used)) if *used_day == day => *used,
            _ => 0,
        }
    }

    fn invoice_used(&self, mandate: &Mandate, invoice_hash: &[u8; 32]) -> bool {
        self.invoices.contains(&invoice_key(&mandate.owner, invoice_hash))
    }
}

/// The daily cap belongs to the owner. Keying it by agent alone would let a
/// stranger spend down a victim agent's allowance from their own mandate.
fn cap_key(owner: &str, agent: &str, token: &Token) -> [u8; 32] {
    let token = match token {
        Token::Native => "",
        Token::Ft(account) => account,
    };
    env::sha256_array(format!("{owner}\n{agent}\n{token}").as_bytes())
}

fn invoice_key(owner: &str, invoice_hash: &[u8; 32]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(owner.len() + 33);
    bytes.extend_from_slice(owner.as_bytes());
    bytes.push(b'\n');
    bytes.extend_from_slice(invoice_hash);
    env::sha256_array(&bytes)
}

fn storage_cost(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear().saturating_mul(u128::from(bytes))
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0xf)]));
    }
    out
}

fn account(id: &str) -> Option<AccountId> {
    id.parse().ok()
}

fn emit(event: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "provingground", "version": "1.0.0", "event": event, "data": [data]})
    );
}

fn yocto(amount: u128) -> NearToken {
    NearToken::from_yoctonear(amount)
}

/// A transfer returns nothing, so only an explicit failure counts as one.
fn transfer_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed))
}

fn decided(
    decision: &str,
    reason: Reason,
    mandate_id: Option<u64>,
    request_id: Option<u64>,
) -> Decision {
    Decision {
        decision: decision.to_string(),
        reason: reason.code().to_string(),
        mandate_id: mandate_id.map(|id| id.to_string()),
        request_id: request_id.map(|id| id.to_string()),
    }
}

/// Refuses an owner call and returns whatever it attached.
fn refuse_owner_call(event_method: &str, reason: Reason, mandate_id: Option<u64>) -> Decision {
    let attached = env::attached_deposit().as_yoctonear();
    if attached > 0 {
        let _ = Promise::new(env::predecessor_account_id()).transfer(yocto(attached));
    }
    emit(
        "call_refused",
        json!({
            "method": event_method,
            "caller": env::predecessor_account_id(),
            "mandate_id": mandate_id.map(|id| id.to_string()),
            "reason": reason.code(),
        }),
    );
    decided("REFUSED", reason, mandate_id, None)
}

#[near]
impl Vault {
    #[init]
    #[private]
    pub fn new(checker: CheckerConfig) -> Self {
        Self {
            checker,
            next_mandate_id: 1,
            next_request_id: 1,
            mandates: LookupMap::new(StorageKey::Mandates),
            requests: LookupMap::new(StorageKey::Requests),
            mandate_requests: LookupMap::new(StorageKey::MandateRequests),
            daily_caps: LookupMap::new(StorageKey::DailyCaps),
            daily_usage: LookupMap::new(StorageKey::DailyUsage),
            invoices: LookupSet::new(StorageKey::Invoices),
        }
    }

    // ---------- Owner: setup ----------

    #[payable]
    pub fn set_daily_cap(&mut self, agent: String, token: Option<String>, cap: U128) -> Decision {
        let Some(agent_id) = account(&agent) else {
            return refuse_owner_call("set_daily_cap", Reason::InvalidAgent, None);
        };
        let token = match token.as_deref() {
            None => Token::Native,
            Some(token) => match account(token) {
                Some(token) => Token::Ft(token.to_string()),
                None => return refuse_owner_call("set_daily_cap", Reason::InvalidToken, None),
            },
        };
        let owner = env::predecessor_account_id();
        let key = cap_key(owner.as_str(), agent_id.as_str(), &token);
        let is_new = !self.daily_caps.contains_key(&key);
        let required = ONE_YOCTO + if is_new { storage_cost(DAILY_CAP_STORAGE_BYTES) } else { 0 };
        let attached = env::attached_deposit().as_yoctonear();
        if attached < required {
            let reason = if attached < ONE_YOCTO {
                Reason::NeedsOneYocto
            } else {
                Reason::InsufficientDeposit
            };
            return refuse_owner_call("set_daily_cap", reason, None);
        }
        self.daily_caps.insert(key, cap.0);
        if attached > required {
            let _ = Promise::new(owner.clone()).transfer(yocto(attached - required));
        }
        emit("daily_cap_set", json!({"owner": owner, "agent": agent_id, "cap": cap}));
        decided("OK", Reason::Settled, None, None)
    }

    #[payable]
    pub fn create_mandate(&mut self, args: CreateMandateArgs) -> Decision {
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = self.next_mandate_id;
        let new = NewMandate {
            owner: owner.as_str(),
            agent: &args.agent,
            payees: &args.payees,
            token: args.token.as_deref(),
            max_total: &args.max_total,
            max_per_payment: &args.max_per_payment,
            purpose_hash: &args.purpose_hash,
            expires_at: args.expires_at.0,
            max_requests: args.max_requests,
            max_checks_per_day: args.max_checks_per_day,
            park_ttl: args.park_ttl.0,
        };
        let mut mandate = match validate_new_mandate(id, &new, now) {
            Ok(mandate) => mandate,
            Err(reason) => return refuse_owner_call("create_mandate", reason, None),
        };

        let record_bytes = MANDATE_BASE_STORAGE_BYTES
            + args.payees.iter().map(|payee| payee.len() as u64 + 4).sum::<u64>()
            + owner.as_str().len() as u64
            + args.agent.len() as u64
            + args.token.as_ref().map_or(0, |token| token.len() as u64);
        let prepaid = storage_cost(u64::from(args.max_requests) * REQUEST_STORAGE_BYTES);
        let required = storage_cost(record_bytes)
            .saturating_add(prepaid)
            .saturating_add(args.checker_budget.0);
        let attached = env::attached_deposit().as_yoctonear();
        if attached < required {
            return refuse_owner_call("create_mandate", Reason::InsufficientDeposit, None);
        }
        let surplus = attached - required;

        mandate.storage_balance = prepaid;
        mandate.checker_budget = args.checker_budget.0;
        if mandate.token == Token::Native {
            mandate.balance = surplus;
        } else if surplus > 0 {
            let _ = Promise::new(owner.clone()).transfer(yocto(surplus));
        }
        let funded = mandate.balance;

        self.next_mandate_id += 1;
        self.mandates.insert(id, mandate);
        emit(
            "mandate_created",
            json!({
                "mandate_id": id.to_string(),
                "owner": owner,
                "agent": args.agent,
                "payees": args.payees,
                "token": args.token,
                "max_total": args.max_total,
                "max_per_payment": args.max_per_payment,
                "purpose_hash": args.purpose_hash,
                "expires_at": args.expires_at,
                "funded": funded.to_string(),
            }),
        );
        decided("OK", Reason::Settled, Some(id), None)
    }

    #[payable]
    pub fn fund(&mut self, mandate_id: U64) -> Decision {
        let id = mandate_id.0;
        let caller = env::predecessor_account_id();
        let Some(mut mandate) = self.mandates.get(&id).cloned() else {
            return refuse_owner_call("fund", Reason::MandateNotFound, Some(id));
        };
        if caller.as_str() != mandate.owner {
            return refuse_owner_call("fund", Reason::NotOwner, Some(id));
        }
        if mandate.token != Token::Native {
            return refuse_owner_call("fund", Reason::TokenMismatch, Some(id));
        }
        if let Some(reason) = not_active(&mandate) {
            return refuse_owner_call("fund", reason, Some(id));
        }
        let amount = env::attached_deposit().as_yoctonear();
        if let Err(reason) = mandate.fund(amount) {
            return refuse_owner_call("fund", reason, Some(id));
        }
        self.mandates.insert(id, mandate);
        emit("mandate_funded", json!({"mandate_id": id.to_string(), "amount": amount.to_string()}));
        decided("OK", Reason::Settled, Some(id), None)
    }

    /// NEP-141 funding. `msg` is the mandate ID. Returns the amount to give back.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let funded = msg.trim().parse::<u64>().ok().and_then(|id| {
            let mut mandate = self.mandates.get(&id).cloned()?;
            let token_matches = mandate.token == Token::Ft(token.to_string());
            if !token_matches
                || sender_id.as_str() != mandate.owner
                || not_active(&mandate).is_some()
                || mandate.fund(amount.0).is_err()
            {
                return None;
            }
            self.mandates.insert(id, mandate);
            Some(id)
        });
        match funded {
            Some(id) => {
                emit("mandate_funded", json!({"mandate_id": id.to_string(), "amount": amount}));
                U128(0)
            }
            None => {
                emit(
                    "call_refused",
                    json!({"method": "ft_on_transfer", "caller": token, "reason": Reason::TokenMismatch.code()}),
                );
                amount
            }
        }
    }

    // ---------- Agent ----------

    /// The only method the agent's key can call. Its arguments are plain strings
    /// so a malformed value gets a reason code like any other refusal.
    #[payable]
    pub fn request_payment(
        &mut self,
        mandate_id: String,
        payee: String,
        amount: String,
        invoice_hash: String,
        blob_ref: String,
        memo: String,
    ) -> PromiseOrValue<Decision> {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let attached = env::attached_deposit().as_yoctonear();
        let id = mandate_id.parse::<u64>().ok();
        let mandate = id.and_then(|id| self.mandates.get(&id).cloned());
        let input = PaymentInput {
            caller: caller.as_str(),
            gas_sufficient: env::prepaid_gas() >= MIN_REQUEST_GAS,
            attached_deposit: attached,
            payee: &payee,
            amount: &amount,
            invoice_hash: &invoice_hash,
            blob_ref: &blob_ref,
            memo: &memo,
        };
        let check_cost = mandate.as_ref().map_or(0, |mandate| self.check_cost(mandate));
        let book = Book {
            daily_caps: &self.daily_caps,
            daily_usage: &self.daily_usage,
            invoices: &self.invoices,
        };
        let storage = storage_cost(REQUEST_STORAGE_BYTES);
        let result = evaluate(&input, mandate.as_ref(), now, check_cost, storage, &book);

        let (accepted, mut mandate) = match (result, mandate) {
            (Ok(accepted), Some(mandate)) => (accepted, mandate),
            (Err(reason), _) => return PromiseOrValue::Value(refuse_request(&input, reason, id)),
            (Ok(_), None) => {
                return PromiseOrValue::Value(refuse_request(&input, Reason::MandateNotFound, id))
            }
        };
        let day = day_of(now);
        if let Err(reason) = mandate.reserve(accepted.amount, day, check_cost, storage) {
            return PromiseOrValue::Value(refuse_request(&input, reason, id));
        }
        let mandate_id = mandate.id;
        let index = mandate.requests_stored - 1;
        let payer = mandate.owner.clone();
        let request_id = self.next_request_id;
        let request = PaymentRequest {
            id: request_id,
            mandate_id,
            payee,
            amount: accepted.amount,
            invoice_hash: accepted.invoice_hash,
            blob_ref,
            memo,
            status: PaymentStatus::Checking,
            reason: Reason::RulesPassed,
            created_at: now,
            updated_at: now,
            day,
        };

        self.next_request_id += 1;
        self.add_daily_usage(&mandate, day, accepted.amount);
        self.invoices.insert(invoice_key(&mandate.owner, &accepted.invoice_hash));
        self.mandate_requests.insert((mandate_id, index), request_id);
        emit_decision(&request, &mandate, "contract", "PASS", Reason::RulesPassed, &[]);
        let promise = self.start_check(&request, &mandate, &payer);
        self.requests.insert(request_id, request);
        self.mandates.insert(mandate_id, mandate);
        PromiseOrValue::Promise(promise)
    }

    // ---------- Checker result and settlement ----------

    #[private]
    pub fn on_verdict(&mut self, request_id: u64) -> PromiseOrValue<Decision> {
        let outcome = match env::promise_result_checked(0, MAX_OUTPUT_LEN) {
            Ok(bytes) => parse_checker_output(&bytes, request_id),
            Err(PromiseError::TooLong(_)) => CheckerOutcome::BadOutput,
            Err(_) => CheckerOutcome::Unavailable,
        };
        let Some((mut request, mandate)) = self.load(request_id) else {
            return PromiseOrValue::Value(decided(
                "REFUSED",
                Reason::RequestNotFound,
                None,
                Some(request_id),
            ));
        };
        let next = match after_verdict(&request, &mandate, env::block_timestamp(), &outcome) {
            Ok(next) => next,
            Err(reason) => {
                // Late verdict: the request already moved on, and nothing changes.
                emit_decision(&request, &mandate, "checker", "IGNORED", reason, &[]);
                return PromiseOrValue::Value(decided(
                    "IGNORED",
                    reason,
                    Some(mandate.id),
                    Some(request_id),
                ));
            }
        };
        let reasons = match &outcome {
            CheckerOutcome::Allow(reasons)
            | CheckerOutcome::Warn(reasons)
            | CheckerOutcome::Block(reasons) => reasons.as_slice(),
            _ => &[],
        };
        match next {
            Next::Pay(reason) => {
                emit_decision(&request, &mandate, "checker", "ALLOW", reason, reasons);
                let promise = self.start_payment(&mut request, &mandate, reason);
                PromiseOrValue::Promise(promise)
            }
            Next::Park(reason) => {
                emit_decision(&request, &mandate, "checker", "PARK", reason, reasons);
                self.update_request(&mut request, PaymentStatus::Parked, reason);
                emit(
                    "payment_parked",
                    json!({"request_id": request_id.to_string(), "reason": reason.code()}),
                );
                PromiseOrValue::Value(decided("PARK", reason, Some(mandate.id), Some(request_id)))
            }
            Next::Block(reason) => {
                emit_decision(&request, &mandate, "checker", "BLOCK", reason, reasons);
                self.finish(&mut request, mandate, PaymentStatus::Blocked, reason, false);
                PromiseOrValue::Value(decided(
                    "BLOCK",
                    reason,
                    Some(request.mandate_id),
                    Some(request_id),
                ))
            }
        }
    }

    #[private]
    pub fn on_settled(&mut self, request_id: u64) -> Decision {
        let succeeded = transfer_succeeded();
        let Some((mut request, mut mandate)) = self.load(request_id) else {
            return decided("REFUSED", Reason::RequestNotFound, None, Some(request_id));
        };
        if request.status != PaymentStatus::Paying {
            return decided("IGNORED", Reason::BadRequestState, Some(mandate.id), Some(request_id));
        }
        if succeeded {
            if let Err(reason) = mandate.settle_paid(request.amount) {
                return decided("REFUSED", reason, Some(mandate.id), Some(request_id));
            }
            self.mandates.insert(mandate.id, mandate);
            self.update_request(&mut request, PaymentStatus::Paid, Reason::Settled);
            emit_settled(&request, true);
            decided("PAID", Reason::Settled, Some(request.mandate_id), Some(request_id))
        } else {
            self.finish(&mut request, mandate, PaymentStatus::Failed, Reason::TransferFailed, true);
            emit_settled(&request, false);
            decided("FAILED", Reason::TransferFailed, Some(request.mandate_id), Some(request_id))
        }
    }

    // ---------- Owner: review and exit ----------

    #[payable]
    pub fn approve(&mut self, request_id: U64) -> PromiseOrValue<Decision> {
        let id = request_id.0;
        let Some((mut request, mandate)) = self.load(id) else {
            return PromiseOrValue::Value(refuse_owner_call(
                "approve",
                Reason::RequestNotFound,
                None,
            ));
        };
        if env::attached_deposit().as_yoctonear() != ONE_YOCTO {
            return PromiseOrValue::Value(refuse_owner_call(
                "approve",
                Reason::NeedsOneYocto,
                Some(mandate.id),
            ));
        }
        if env::prepaid_gas() < MIN_APPROVE_GAS {
            return PromiseOrValue::Value(refuse_owner_call(
                "approve",
                Reason::GasTooLow,
                Some(mandate.id),
            ));
        }
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        if let Err(reason) = approve_check(&request, &mandate, caller.as_str(), now) {
            return PromiseOrValue::Value(refuse_owner_call("approve", reason, Some(mandate.id)));
        }
        emit("payment_approved", json!({"request_id": id.to_string(), "owner": caller}));
        emit_decision(&request, &mandate, "owner", "APPROVE", Reason::OwnerApproved, &[]);
        let promise = self.start_payment(&mut request, &mandate, Reason::OwnerApproved);
        PromiseOrValue::Promise(promise)
    }

    #[payable]
    pub fn reject(&mut self, request_id: U64) -> Decision {
        let id = request_id.0;
        let Some((mut request, mandate)) = self.load(id) else {
            return refuse_owner_call("reject", Reason::RequestNotFound, None);
        };
        if env::attached_deposit().as_yoctonear() != ONE_YOCTO {
            return refuse_owner_call("reject", Reason::NeedsOneYocto, Some(mandate.id));
        }
        let caller = env::predecessor_account_id();
        if let Err(reason) = reject_check(&request, &mandate, caller.as_str()) {
            return refuse_owner_call("reject", reason, Some(mandate.id));
        }
        emit_decision(&request, &mandate, "owner", "REJECT", Reason::OwnerRejected, &[]);
        let mandate_id = mandate.id;
        self.finish(&mut request, mandate, PaymentStatus::Rejected, Reason::OwnerRejected, false);
        emit(
            "payment_rejected",
            json!({"request_id": id.to_string(), "reason": Reason::OwnerRejected.code()}),
        );
        decided("REJECTED", Reason::OwnerRejected, Some(mandate_id), Some(id))
    }

    #[payable]
    pub fn revoke(&mut self, mandate_id: U64) -> Decision {
        let id = mandate_id.0;
        let Some(mut mandate) = self.owned_mandate(id) else {
            return self.owner_failure("revoke", id);
        };
        if mandate.status == MandateStatus::Active {
            mandate.status = MandateStatus::Revoked;
            self.mandates.insert(id, mandate);
            emit("mandate_revoked", json!({"mandate_id": id.to_string()}));
        }
        decided("OK", Reason::MandateRevoked, Some(id), None)
    }

    #[payable]
    pub fn withdraw(&mut self, mandate_id: U64, amount: U128) -> PromiseOrValue<Decision> {
        let id = mandate_id.0;
        let Some(mut mandate) = self.owned_mandate(id) else {
            return PromiseOrValue::Value(self.owner_failure("withdraw", id));
        };
        if let Err(reason) = mandate.withdraw(amount.0) {
            return PromiseOrValue::Value(refuse_owner_call("withdraw", reason, Some(id)));
        }
        let owner = env::predecessor_account_id();
        let transfer = match &mandate.token {
            Token::Native => Promise::new(owner.clone()).transfer(yocto(amount.0)),
            Token::Ft(token) => match account(token) {
                Some(token) => ext_ft::ext(token)
                    .with_attached_deposit(yocto(ONE_YOCTO))
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(owner.clone(), amount, None),
                None => {
                    return PromiseOrValue::Value(refuse_owner_call(
                        "withdraw",
                        Reason::InvalidToken,
                        Some(id),
                    ))
                }
            },
        };
        self.mandates.insert(id, mandate);
        emit(
            "mandate_withdrawn",
            json!({"mandate_id": id.to_string(), "amount": amount, "to": owner}),
        );
        PromiseOrValue::Promise(
            transfer.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RESTORE)
                    .on_withdraw_settled(id, amount),
            ),
        )
    }

    #[private]
    pub fn on_withdraw_settled(&mut self, mandate_id: u64, amount: U128) -> Decision {
        if transfer_succeeded() {
            return decided("OK", Reason::Settled, Some(mandate_id), None);
        }
        if let Some(mut mandate) = self.mandates.get(&mandate_id).cloned() {
            if mandate.fund(amount.0).is_ok() {
                self.mandates.insert(mandate_id, mandate);
            }
        }
        emit(
            "mandate_withdraw_failed",
            json!({"mandate_id": mandate_id.to_string(), "amount": amount}),
        );
        decided("FAILED", Reason::TransferFailed, Some(mandate_id), None)
    }

    /// Ends a mandate and returns its unused checker budget and storage prepayment.
    /// Withdraw the balance first. Can be called again if the refund failed.
    #[payable]
    pub fn close(&mut self, mandate_id: U64) -> PromiseOrValue<Decision> {
        let id = mandate_id.0;
        let Some(mut mandate) = self.owned_mandate(id) else {
            return PromiseOrValue::Value(self.owner_failure("close", id));
        };
        if mandate.reserved != 0 {
            return PromiseOrValue::Value(refuse_owner_call(
                "close",
                Reason::RequestsInFlight,
                Some(id),
            ));
        }
        if mandate.balance != 0 {
            return PromiseOrValue::Value(refuse_owner_call(
                "close",
                Reason::MandateNotEmpty,
                Some(id),
            ));
        }
        let checker_budget = mandate.checker_budget;
        let storage_balance = mandate.storage_balance;
        mandate.status = MandateStatus::Closed;
        mandate.checker_budget = 0;
        mandate.storage_balance = 0;
        self.mandates.insert(id, mandate);
        let refund = checker_budget.saturating_add(storage_balance).saturating_add(ONE_YOCTO);
        emit("mandate_closed", json!({"mandate_id": id.to_string(), "refund": refund.to_string()}));
        PromiseOrValue::Promise(
            Promise::new(env::predecessor_account_id()).transfer(yocto(refund)).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RESTORE)
                    .on_close_settled(id, U128(checker_budget), U128(storage_balance)),
            ),
        )
    }

    #[private]
    pub fn on_close_settled(
        &mut self,
        mandate_id: u64,
        checker_budget: U128,
        storage_balance: U128,
    ) -> Decision {
        if transfer_succeeded() {
            return decided("OK", Reason::Settled, Some(mandate_id), None);
        }
        if let Some(mut mandate) = self.mandates.get(&mandate_id).cloned() {
            mandate.checker_budget = mandate.checker_budget.saturating_add(checker_budget.0);
            mandate.storage_balance = mandate.storage_balance.saturating_add(storage_balance.0);
            self.mandates.insert(mandate_id, mandate);
        }
        decided("FAILED", Reason::TransferFailed, Some(mandate_id), None)
    }

    /// Anyone can call this. It can only move reserved funds back into the mandate.
    pub fn release_stale(&mut self, request_id: U64) -> Decision {
        let id = request_id.0;
        let Some((mut request, mandate)) = self.load(id) else {
            return decided("REFUSED", Reason::RequestNotFound, None, Some(id));
        };
        let mandate_id = mandate.id;
        let now = env::block_timestamp();
        match stale_check(&request, &mandate, now, self.checker.check_timeout_ns.0) {
            Ok(Stale::RejectParked) => {
                self.finish(
                    &mut request,
                    mandate,
                    PaymentStatus::Rejected,
                    Reason::ParkExpired,
                    false,
                );
                emit(
                    "payment_rejected",
                    json!({"request_id": id.to_string(), "reason": Reason::ParkExpired.code()}),
                );
                decided("REJECTED", Reason::ParkExpired, Some(mandate_id), Some(id))
            }
            Ok(Stale::FailChecking) => {
                self.finish(
                    &mut request,
                    mandate,
                    PaymentStatus::Failed,
                    Reason::CheckerUnavailable,
                    true,
                );
                decided("FAILED", Reason::CheckerUnavailable, Some(mandate_id), Some(id))
            }
            Err(reason) => decided("REFUSED", reason, Some(mandate_id), Some(id)),
        }
    }

    // ---------- Views ----------

    pub fn get_mandate(&self, mandate_id: U64) -> Option<MandateView> {
        self.mandates.get(&mandate_id.0).map(mandate_view)
    }

    pub fn get_request(&self, request_id: U64) -> Option<RequestView> {
        self.requests.get(&request_id.0).map(request_view)
    }

    pub fn list_requests(&self, mandate_id: U64, from_index: u32, limit: u32) -> Vec<RequestView> {
        (from_index..from_index.saturating_add(limit.min(100)))
            .map_while(|index| self.mandate_requests.get(&(mandate_id.0, index)))
            .filter_map(|id| self.requests.get(id))
            .map(request_view)
            .collect()
    }

    pub fn get_daily_status(
        &self,
        owner: String,
        agent: String,
        token: Option<String>,
    ) -> DailyStatus {
        let token = token.map_or(Token::Native, Token::Ft);
        let key = cap_key(&owner, &agent, &token);
        let today = day_of(env::block_timestamp());
        DailyStatus {
            cap: self.daily_caps.get(&key).map(|cap| U128(*cap)),
            used_today: U128(match self.daily_usage.get(&key) {
                Some((day, used)) if *day == today => *used,
                _ => 0,
            }),
        }
    }

    pub fn is_invoice_used(&self, owner: String, invoice_hash: String) -> bool {
        parse_hash(&invoice_hash)
            .is_some_and(|hash| self.invoices.contains(&invoice_key(&owner, &hash)))
    }

    pub fn get_checker_config(&self) -> CheckerConfig {
        self.checker.clone()
    }
}

fn not_active(mandate: &Mandate) -> Option<Reason> {
    match mandate.status {
        MandateStatus::Active => None,
        MandateStatus::Revoked => Some(Reason::MandateRevoked),
        MandateStatus::Closed => Some(Reason::MandateClosed),
    }
}

fn refuse_request(input: &PaymentInput, reason: Reason, mandate_id: Option<u64>) -> Decision {
    let attached = input.attached_deposit;
    if attached > 0 {
        let _ = Promise::new(env::predecessor_account_id()).transfer(yocto(attached));
    }
    // Attacker-chosen strings are logged only when they are short, valid values, so
    // the logs cannot be used to publish a payload.
    let payee = provingground_core::is_valid_account_id(input.payee).then_some(input.payee);
    emit(
        "payment_decided",
        json!({
            "mandate_id": mandate_id.map(|id| id.to_string()),
            "request_id": Value::Null,
            "agent": input.caller,
            "payee": payee,
            "payee_len": input.payee.len(),
            "amount_len": input.amount.len(),
            "memo_len": input.memo.len(),
            "layer": "contract",
            "decision": "BLOCK",
            "reason": reason.code(),
        }),
    );
    decided("BLOCK", reason, mandate_id, None)
}

fn emit_decision(
    request: &PaymentRequest,
    mandate: &Mandate,
    layer: &str,
    decision: &str,
    reason: Reason,
    checker_reasons: &[&str],
) {
    emit(
        "payment_decided",
        json!({
            "mandate_id": mandate.id.to_string(),
            "request_id": request.id.to_string(),
            "agent": mandate.agent,
            "payee": request.payee,
            "amount": request.amount.to_string(),
            "invoice_hash": to_hex(&request.invoice_hash),
            "layer": layer,
            "decision": decision,
            "reason": reason.code(),
            "checker_reasons": checker_reasons,
        }),
    );
}

fn emit_settled(request: &PaymentRequest, succeeded: bool) {
    emit(
        "payment_settled",
        json!({
            "request_id": request.id.to_string(),
            "payee": request.payee,
            "amount": request.amount.to_string(),
            "success": succeeded,
        }),
    );
}

fn mandate_view(mandate: &Mandate) -> MandateView {
    MandateView {
        id: U64(mandate.id),
        owner: mandate.owner.clone(),
        agent: mandate.agent.clone(),
        payees: mandate.payees.clone(),
        token: match &mandate.token {
            Token::Native => None,
            Token::Ft(token) => Some(token.clone()),
        },
        max_total: U128(mandate.max_total),
        max_per_payment: U128(mandate.max_per_payment),
        purpose_hash: to_hex(&mandate.purpose_hash),
        expires_at: U64(mandate.expires_at),
        max_requests: mandate.max_requests,
        max_checks_per_day: mandate.max_checks_per_day,
        park_ttl: U64(mandate.park_ttl),
        status: match mandate.status {
            MandateStatus::Active => "Active",
            MandateStatus::Revoked => "Revoked",
            MandateStatus::Closed => "Closed",
        }
        .to_string(),
        balance: U128(mandate.balance),
        reserved: U128(mandate.reserved),
        spent: U128(mandate.spent),
        checker_budget: U128(mandate.checker_budget),
        storage_balance: U128(mandate.storage_balance),
        requests_stored: mandate.requests_stored,
    }
}

fn request_view(request: &PaymentRequest) -> RequestView {
    RequestView {
        id: U64(request.id),
        mandate_id: U64(request.mandate_id),
        payee: request.payee.clone(),
        amount: U128(request.amount),
        invoice_hash: to_hex(&request.invoice_hash),
        blob_ref: request.blob_ref.clone(),
        memo: request.memo.clone(),
        status: request.status.as_str().to_string(),
        reason: request.reason.code().to_string(),
        created_at: U64(request.created_at),
        updated_at: U64(request.updated_at),
    }
}

impl Vault {
    fn load(&self, request_id: u64) -> Option<(PaymentRequest, Mandate)> {
        let request = self.requests.get(&request_id)?.clone();
        let mandate = self.mandates.get(&request.mandate_id)?.clone();
        Some((request, mandate))
    }

    /// The NEP-141 path pays 1 yocto for each ft_transfer out of the checker budget.
    fn check_cost(&self, mandate: &Mandate) -> u128 {
        let transfer_cost = if mandate.token == Token::Native { 0 } else { ONE_YOCTO };
        self.checker.fee.0.saturating_add(transfer_cost)
    }

    /// Common guard for owner calls with a 1 yocto deposit.
    fn owned_mandate(&self, id: u64) -> Option<Mandate> {
        let mandate = self.mandates.get(&id)?;
        let is_owner = env::predecessor_account_id().as_str() == mandate.owner;
        (is_owner && env::attached_deposit().as_yoctonear() == ONE_YOCTO).then(|| mandate.clone())
    }

    fn owner_failure(&self, method: &str, id: u64) -> Decision {
        let reason = match self.mandates.get(&id) {
            None => Reason::MandateNotFound,
            Some(mandate) if env::predecessor_account_id().as_str() != mandate.owner => {
                Reason::NotOwner
            }
            Some(_) => Reason::NeedsOneYocto,
        };
        refuse_owner_call(method, reason, Some(id))
    }

    fn add_daily_usage(&mut self, mandate: &Mandate, day: u64, amount: u128) {
        let key = cap_key(&mandate.owner, &mandate.agent, &mandate.token);
        let used = match self.daily_usage.get(&key) {
            Some((used_day, used)) if *used_day == day => *used,
            _ => 0,
        };
        self.daily_usage.insert(key, (day, used.saturating_add(amount)));
    }

    fn release_daily_usage(&mut self, mandate: &Mandate, day: u64, amount: u128) {
        let key = cap_key(&mandate.owner, &mandate.agent, &mandate.token);
        if let Some((used_day, used)) = self.daily_usage.get(&key).copied() {
            if used_day == day {
                self.daily_usage.insert(key, (day, used.saturating_sub(amount)));
            }
        }
    }

    fn update_request(
        &mut self,
        request: &mut PaymentRequest,
        status: PaymentStatus,
        reason: Reason,
    ) {
        request.status = status;
        request.reason = reason;
        request.updated_at = env::block_timestamp();
        self.requests.insert(request.id, request.clone());
    }

    /// Ends a request without paying: the budget and daily allowance go back, and
    /// the invoice hash is only released when no verdict or payment ever happened.
    fn finish(
        &mut self,
        request: &mut PaymentRequest,
        mut mandate: Mandate,
        status: PaymentStatus,
        reason: Reason,
        release_invoice: bool,
    ) {
        mandate.reserved = mandate.reserved.saturating_sub(request.amount);
        self.release_daily_usage(&mandate, request.day, request.amount);
        if release_invoice {
            self.invoices.remove(&invoice_key(&mandate.owner, &request.invoice_hash));
        }
        self.mandates.insert(mandate.id, mandate);
        self.update_request(request, status, reason);
    }

    fn start_check(&self, request: &PaymentRequest, mandate: &Mandate, payer: &str) -> Promise {
        let token = match &mandate.token {
            Token::Native => None,
            Token::Ft(token) => Some(token.clone()),
        };
        let input = json!({
            "v": 1,
            "request_id": request.id.to_string(),
            "mandate_id": mandate.id.to_string(),
            "agent": mandate.agent,
            "payee": request.payee,
            "amount": request.amount.to_string(),
            "token": token,
            "purpose_hash": to_hex(&mandate.purpose_hash),
            "invoice_hash": to_hex(&request.invoice_hash),
            "blob_ref": request.blob_ref,
            "memo": request.memo,
        });
        let config = &self.checker;
        let args = json!({
            "source": match &config.source {
                CheckerSource::WasmUrl { url, hash, build_target } => json!({
                    "WasmUrl": {"url": url, "hash": hash, "build_target": build_target}
                }),
                CheckerSource::Project { project_id, version_key } => json!({
                    "Project": {"project_id": project_id, "version_key": version_key}
                }),
            },
            "resource_limits": {
                "max_instructions": config.max_instructions.0,
                "max_memory_mb": config.max_memory_mb,
                "max_execution_seconds": config.max_execution_seconds.0,
            },
            "input_data": input.to_string(),
            "secrets_ref": config.secrets_ref.as_ref().map(|secrets| json!({
                "profile": secrets.profile,
                "account_id": secrets.account_id,
            })),
            "response_format": "Json",
            "payer_account_id": payer,
        });
        Promise::new(config.outlayer.clone())
            .function_call(
                "request_execution".to_string(),
                serde_json::to_vec(&args).unwrap_or_default(),
                yocto(config.fee.0),
                GAS_REQUEST_EXECUTION,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_VERDICT)
                    .on_verdict(request.id),
            )
    }

    /// Payee and amount come from the stored request. No caller can supply them.
    fn start_payment(
        &mut self,
        request: &mut PaymentRequest,
        mandate: &Mandate,
        reason: Reason,
    ) -> Promise {
        self.update_request(request, PaymentStatus::Paying, reason);
        let settle = Self::ext(env::current_account_id())
            .with_static_gas(GAS_ON_SETTLED)
            .on_settled(request.id);
        // The payee was validated against the mandate when the request was accepted.
        let payee: AccountId = request.payee.parse().unwrap_or_else(|_| env::current_account_id());
        let transfer = match &mandate.token {
            Token::Native => Promise::new(payee).transfer(yocto(request.amount)),
            Token::Ft(token) => {
                let token: AccountId = token.parse().unwrap_or_else(|_| env::current_account_id());
                ext_ft::ext(token)
                    .with_attached_deposit(yocto(ONE_YOCTO))
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(payee, U128(request.amount), None)
            }
        };
        transfer.then(settle)
    }
}
