use crate::verdict::CheckerOutcome;
use crate::{
    day_of, is_valid_account_id, Mandate, MandateStatus, PaymentRequest, PaymentStatus, Reason,
    Token,
};

pub const MAX_PAYEE_LEN: usize = 128;
pub const MAX_AMOUNT_LEN: usize = 64;
pub const MAX_HASH_LEN: usize = 128;
pub const MAX_BLOB_REF_LEN: usize = 256;
pub const MAX_MEMO_LEN: usize = 256;
pub const MAX_PAYEES: usize = 16;
pub const MAX_REQUESTS: u32 = 10_000;
pub const MAX_PARK_TTL_NS: u64 = 30 * 86_400_000_000_000;

/// What the contract rules read from storage. The contract backs this with its
/// collections and the mock harness with maps.
pub trait Ledger {
    fn daily_cap(&self, mandate: &Mandate) -> Option<u128>;
    fn daily_used(&self, mandate: &Mandate, day: u64) -> u128;
    fn invoice_used(&self, mandate: &Mandate, invoice_hash: &[u8; 32]) -> bool;
}

/// A request exactly as the caller sent it. Everything is an unvalidated string
/// so malformed values get a reason code, not a deserialization failure.
#[derive(Clone, Copy, Debug)]
pub struct PaymentInput<'a> {
    pub caller: &'a str,
    pub gas_sufficient: bool,
    pub attached_deposit: u128,
    pub payee: &'a str,
    pub amount: &'a str,
    pub invoice_hash: &'a str,
    pub blob_ref: &'a str,
    pub memo: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accepted {
    pub amount: u128,
    pub invoice_hash: [u8; 32],
}

/// The contract rules, documented in docs/MANDATES.md. The first failure decides.
pub fn evaluate<L: Ledger>(
    input: &PaymentInput,
    mandate: Option<&Mandate>,
    now_ns: u64,
    check_cost: u128,
    storage_cost: u128,
    ledger: &L,
) -> Result<Accepted, Reason> {
    if !input.gas_sufficient {
        return Err(Reason::GasTooLow);
    }
    if input.attached_deposit != 0 {
        return Err(Reason::DepositNotAllowed);
    }
    if input.payee.len() > MAX_PAYEE_LEN
        || input.amount.len() > MAX_AMOUNT_LEN
        || input.invoice_hash.len() > MAX_HASH_LEN
        || input.blob_ref.len() > MAX_BLOB_REF_LEN
        || input.memo.len() > MAX_MEMO_LEN
    {
        return Err(Reason::InputTooLarge);
    }
    let amount = parse_amount(input.amount).ok_or(Reason::AmountInvalid)?;
    let invoice_hash = parse_hash(input.invoice_hash).ok_or(Reason::InvoiceHashInvalid)?;
    let mandate = mandate.ok_or(Reason::MandateNotFound)?;
    if input.caller != mandate.agent {
        return Err(Reason::NotAgent);
    }
    match mandate.status {
        MandateStatus::Active => {}
        MandateStatus::Revoked => return Err(Reason::MandateRevoked),
        MandateStatus::Closed => return Err(Reason::MandateClosed),
    }
    if mandate.is_expired(now_ns) {
        return Err(Reason::MandateExpired);
    }
    if !is_valid_account_id(input.payee) {
        return Err(Reason::PayeeInvalid);
    }
    if !mandate.payees.iter().any(|payee| payee == input.payee) {
        return Err(Reason::PayeeNotAllowed);
    }
    if amount > mandate.max_per_payment {
        return Err(Reason::OverPerPayment);
    }
    let committed = mandate.spent.checked_add(mandate.reserved).ok_or(Reason::Overflow)?;
    if amount > mandate.max_total.saturating_sub(committed) {
        return Err(Reason::OverTotal);
    }
    if amount > mandate.withdrawable() {
        return Err(Reason::InsufficientBalance);
    }
    let cap = ledger.daily_cap(mandate).ok_or(Reason::DailyCapUnset)?;
    let day = day_of(now_ns);
    if amount > cap.saturating_sub(ledger.daily_used(mandate, day)) {
        return Err(Reason::OverDailyCap);
    }
    if ledger.invoice_used(mandate, &invoice_hash) {
        return Err(Reason::Replay);
    }
    if mandate.requests_stored >= mandate.max_requests || mandate.storage_balance < storage_cost {
        return Err(Reason::RequestLimit);
    }
    if mandate.checks_on(day) >= mandate.max_checks_per_day {
        return Err(Reason::CheckLimit);
    }
    if mandate.checker_budget < check_cost {
        return Err(Reason::CheckerBudgetExhausted);
    }
    Ok(Accepted { amount, invoice_hash })
}

fn parse_amount(text: &str) -> Option<u128> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|amount| *amount > 0)
}

pub fn parse_hash(text: &str) -> Option<[u8; 32]> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (slot, pair) in out.iter_mut().zip(bytes.chunks_exact(2)) {
        *slot = hex_digit(pair[0])? << 4 | hex_digit(pair[1])?;
    }
    Some(out)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

/// Mandate creation arguments as the owner sent them.
#[derive(Clone, Debug)]
pub struct NewMandate<'a> {
    pub owner: &'a str,
    pub agent: &'a str,
    pub payees: &'a [String],
    pub token: Option<&'a str>,
    pub max_total: &'a str,
    pub max_per_payment: &'a str,
    pub purpose_hash: &'a str,
    pub expires_at: u64,
    pub max_requests: u32,
    pub max_checks_per_day: u32,
    pub park_ttl: u64,
}

/// Validates creation arguments and returns an unfunded active mandate.
pub fn validate_new_mandate(id: u64, new: &NewMandate, now_ns: u64) -> Result<Mandate, Reason> {
    if !is_valid_account_id(new.agent) {
        return Err(Reason::InvalidAgent);
    }
    if new.payees.is_empty()
        || new.payees.len() > MAX_PAYEES
        || !new.payees.iter().all(|payee| is_valid_account_id(payee))
    {
        return Err(Reason::InvalidPayees);
    }
    let token = match new.token {
        None => Token::Native,
        Some(token) if is_valid_account_id(token) => Token::Ft(token.to_string()),
        Some(_) => return Err(Reason::InvalidToken),
    };
    let max_total = parse_amount(new.max_total).ok_or(Reason::InvalidLimits)?;
    let max_per_payment = parse_amount(new.max_per_payment).ok_or(Reason::InvalidLimits)?;
    if max_per_payment > max_total {
        return Err(Reason::InvalidLimits);
    }
    let purpose_hash = parse_hash(new.purpose_hash).ok_or(Reason::InvalidPurposeHash)?;
    if new.expires_at <= now_ns {
        return Err(Reason::InvalidExpiry);
    }
    if new.max_requests == 0
        || new.max_requests > MAX_REQUESTS
        || new.max_checks_per_day == 0
        || new.park_ttl == 0
        || new.park_ttl > MAX_PARK_TTL_NS
    {
        return Err(Reason::InvalidQuotas);
    }
    Ok(Mandate {
        id,
        owner: new.owner.to_string(),
        agent: new.agent.to_string(),
        payees: new.payees.to_vec(),
        token,
        max_total,
        max_per_payment,
        purpose_hash,
        expires_at: new.expires_at,
        max_requests: new.max_requests,
        max_checks_per_day: new.max_checks_per_day,
        park_ttl: new.park_ttl,
        status: MandateStatus::Active,
        balance: 0,
        reserved: 0,
        spent: 0,
        checker_budget: 0,
        storage_balance: 0,
        requests_stored: 0,
        checks_day: 0,
        checks_today: 0,
    })
}

/// What happens to a request once the checker has answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    Pay(Reason),
    Park(Reason),
    Block(Reason),
}

/// The checker's answer can only ever lead to paying the stored request. Payee
/// and amount are not inputs here.
pub fn after_verdict(
    request: &PaymentRequest,
    mandate: &Mandate,
    now_ns: u64,
    outcome: &CheckerOutcome,
) -> Result<Next, Reason> {
    if request.status != PaymentStatus::Checking {
        return Err(Reason::BadRequestState);
    }
    match mandate.status {
        MandateStatus::Active => {}
        MandateStatus::Revoked => return Ok(Next::Block(Reason::MandateRevoked)),
        MandateStatus::Closed => return Ok(Next::Block(Reason::MandateClosed)),
    }
    if mandate.is_expired(now_ns) {
        return Ok(Next::Block(Reason::MandateExpired));
    }
    Ok(match outcome {
        CheckerOutcome::Allow(_) => Next::Pay(Reason::CheckerAllow),
        CheckerOutcome::Warn(_) => Next::Park(Reason::CheckerWarn),
        CheckerOutcome::Block(_) => Next::Block(Reason::CheckerBlock),
        CheckerOutcome::Unavailable => Next::Park(Reason::CheckerUnavailable),
        CheckerOutcome::BadOutput => Next::Park(Reason::CheckerBadOutput),
    })
}

fn park_expired(request: &PaymentRequest, mandate: &Mandate, now_ns: u64) -> bool {
    now_ns >= request.updated_at.saturating_add(mandate.park_ttl)
}

/// Owner approval passes the checker, never the mandate. It is re-checked here.
pub fn approve_check(
    request: &PaymentRequest,
    mandate: &Mandate,
    caller: &str,
    now_ns: u64,
) -> Result<(), Reason> {
    if caller != mandate.owner {
        return Err(Reason::NotOwner);
    }
    if request.status != PaymentStatus::Parked {
        return Err(Reason::BadRequestState);
    }
    match mandate.status {
        MandateStatus::Active => {}
        MandateStatus::Revoked => return Err(Reason::MandateRevoked),
        MandateStatus::Closed => return Err(Reason::MandateClosed),
    }
    if mandate.is_expired(now_ns) {
        return Err(Reason::MandateExpired);
    }
    if park_expired(request, mandate, now_ns) {
        return Err(Reason::ParkExpired);
    }
    Ok(())
}

pub fn reject_check(
    request: &PaymentRequest,
    mandate: &Mandate,
    caller: &str,
) -> Result<(), Reason> {
    if caller != mandate.owner {
        return Err(Reason::NotOwner);
    }
    if request.status != PaymentStatus::Parked {
        return Err(Reason::BadRequestState);
    }
    Ok(())
}

/// How a stuck request may be released. `Paying` is never released: the transfer
/// outcome is unknown, so its budget stays held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stale {
    RejectParked,
    FailChecking,
}

pub fn stale_check(
    request: &PaymentRequest,
    mandate: &Mandate,
    now_ns: u64,
    check_timeout_ns: u64,
) -> Result<Stale, Reason> {
    match request.status {
        PaymentStatus::Parked if park_expired(request, mandate, now_ns) => Ok(Stale::RejectParked),
        PaymentStatus::Checking
            if now_ns >= request.created_at.saturating_add(check_timeout_ns) =>
        {
            Ok(Stale::FailChecking)
        }
        PaymentStatus::Parked | PaymentStatus::Checking => Err(Reason::NotStale),
        _ => Err(Reason::BadRequestState),
    }
}
