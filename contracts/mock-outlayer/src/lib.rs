//! Test double for OutLayer's `request_execution`. It uses a real yield/resume, so
//! a request stays in flight until a test resolves it or the yield times out, and
//! like the real contract it returns the raw output bytes, or `null` for a failure.

use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError, YieldId,
};

const OVERSIZED: &str = "__oversized:";

#[near(serializers = [json])]
pub struct RecordedCall {
    pub request_id: u64,
    pub caller: AccountId,
    pub payer: Option<AccountId>,
    pub deposit: U128,
    pub source: Value,
    pub input_data: String,
    pub response_format: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutLayer {
    next_request_id: u64,
    min_deposit: u128,
    fail_requests: bool,
    pending: LookupMap<u64, YieldId>,
    calls: LookupMap<u64, String>,
}

#[near]
impl MockOutLayer {
    #[init]
    pub fn new(min_deposit: U128) -> Self {
        Self {
            next_request_id: 1,
            min_deposit: min_deposit.0,
            fail_requests: false,
            pending: LookupMap::new(b"p"),
            calls: LookupMap::new(b"c"),
        }
    }

    pub fn set_fail_requests(&mut self, fail: bool) {
        self.fail_requests = fail;
    }

    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
    ) -> Promise {
        let _ = (resource_limits, secrets_ref);
        assert!(!self.fail_requests, "mock outage");
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit >= self.min_deposit, "Insufficient payment");

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let (promise, yield_id) = Promise::new_yield(
            "on_execution_response",
            near_sdk::serde_json::json!({
                "payer": payer_account_id.clone().unwrap_or_else(env::predecessor_account_id),
                "refund": U128(deposit),
            })
            .to_string()
            .into_bytes(),
            Gas::from_tgas(10),
            GasWeight::default(),
        );
        self.pending.insert(request_id, yield_id);
        let call = RecordedCall {
            request_id,
            caller: env::predecessor_account_id(),
            payer: payer_account_id,
            deposit: U128(deposit),
            source,
            input_data: input_data.unwrap_or_default(),
            response_format,
        };
        self.calls.insert(request_id, near_sdk::serde_json::to_string(&call).unwrap());
        promise
    }

    /// `output` is exactly what the checker wrote to stdout. `None` is a failed run.
    pub fn resolve(&mut self, request_id: u64, output: Option<String>) {
        let yield_id = self.pending.remove(&request_id).expect("no pending request");
        let body = near_sdk::serde_json::to_vec(&output).unwrap();
        yield_id.resume(body).expect("yield no longer available");
    }

    /// Yield data is limited to 1 KB, so oversized output is produced by the callback,
    /// the way the real contract returns large output from state.
    pub fn resolve_oversized(&mut self, request_id: u64, length: u32) {
        self.resolve(request_id, Some(format!("{OVERSIZED}{length}")));
    }

    #[private]
    pub fn on_execution_response(
        &mut self,
        payer: AccountId,
        refund: U128,
        #[callback_result] output: Result<Option<String>, PromiseError>,
    ) {
        let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(refund.0));
        match output {
            Ok(Some(text)) => match text.strip_prefix(OVERSIZED).and_then(|n| n.parse().ok()) {
                Some(length) => env::value_return(vec![b'x'; length]),
                None => env::value_return(text.as_bytes()),
            },
            _ => env::value_return(b"null"),
        }
    }

    pub fn get_call(&self, request_id: u64) -> Option<RecordedCall> {
        self.calls.get(&request_id).map(|call| near_sdk::serde_json::from_str(call).unwrap())
    }

    pub fn request_count(&self) -> u64 {
        self.next_request_id - 1
    }
}
