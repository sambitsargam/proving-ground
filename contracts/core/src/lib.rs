//! Payment mandate rules with no chain dependency.
//!
//! The vault contract and the mock attack harness both run this code, so what
//! the harness reports is what the contract does.

mod account;
mod mandate;
mod reason;
mod rules;
mod verdict;

pub use account::is_valid_account_id;
pub use mandate::{day_of, Mandate, MandateStatus, PaymentRequest, PaymentStatus, Token};
pub use reason::Reason;
pub use rules::{
    after_verdict, approve_check, evaluate, parse_hash, reject_check, stale_check,
    validate_new_mandate, Accepted, Ledger, NewMandate, Next, PaymentInput, Stale, MAX_AMOUNT_LEN,
    MAX_BLOB_REF_LEN, MAX_HASH_LEN, MAX_MEMO_LEN, MAX_PARK_TTL_NS, MAX_PAYEES, MAX_PAYEE_LEN,
    MAX_REQUESTS,
};
pub use verdict::{parse_checker_output, CheckerOutcome, MAX_OUTPUT_LEN};
