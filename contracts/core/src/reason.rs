use borsh::{BorshDeserialize, BorshSerialize};

macro_rules! reasons {
    ($($variant:ident => $code:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
        #[borsh(use_discriminant = false)]
        pub enum Reason {
            $($variant,)*
        }

        impl Reason {
            pub const ALL: &'static [Reason] = &[$(Reason::$variant,)*];

            pub const fn code(self) -> &'static str {
                match self {
                    $(Reason::$variant => $code,)*
                }
            }
        }
    };
}

reasons! {
    // Request rules, in evaluation order.
    GasTooLow => "GAS_TOO_LOW",
    DepositNotAllowed => "DEPOSIT_NOT_ALLOWED",
    InputTooLarge => "INPUT_TOO_LARGE",
    AmountInvalid => "AMOUNT_INVALID",
    InvoiceHashInvalid => "INVOICE_HASH_INVALID",
    MandateNotFound => "MANDATE_NOT_FOUND",
    NotAgent => "NOT_AGENT",
    MandateRevoked => "MANDATE_REVOKED",
    MandateClosed => "MANDATE_CLOSED",
    MandateExpired => "MANDATE_EXPIRED",
    PayeeInvalid => "PAYEE_INVALID",
    PayeeNotAllowed => "PAYEE_NOT_ALLOWED",
    OverPerPayment => "OVER_PER_PAYMENT",
    OverTotal => "OVER_TOTAL",
    InsufficientBalance => "INSUFFICIENT_BALANCE",
    DailyCapUnset => "DAILY_CAP_UNSET",
    OverDailyCap => "OVER_DAILY_CAP",
    Replay => "REPLAY",
    RequestLimit => "REQUEST_LIMIT",
    CheckLimit => "CHECK_LIMIT",
    CheckerBudgetExhausted => "CHECKER_BUDGET_EXHAUSTED",
    // Checker outcomes.
    CheckerAllow => "CHECKER_ALLOW",
    CheckerWarn => "CHECKER_WARN",
    CheckerBlock => "CHECKER_BLOCK",
    CheckerUnavailable => "CHECKER_UNAVAILABLE",
    CheckerBadOutput => "CHECKER_BAD_OUTPUT",
    // Owner review and settlement.
    OwnerApproved => "OWNER_APPROVED",
    OwnerRejected => "OWNER_REJECTED",
    ParkExpired => "PARK_EXPIRED",
    Settled => "SETTLED",
    TransferFailed => "TRANSFER_FAILED",
    // Owner and maintenance calls.
    NotOwner => "NOT_OWNER",
    NeedsOneYocto => "NEEDS_ONE_YOCTO",
    RequestNotFound => "REQUEST_NOT_FOUND",
    BadRequestState => "BAD_REQUEST_STATE",
    NotStale => "NOT_STALE",
    OverWithdrawable => "OVER_WITHDRAWABLE",
    MandateNotEmpty => "MANDATE_NOT_EMPTY",
    RequestsInFlight => "REQUESTS_IN_FLIGHT",
    TokenMismatch => "TOKEN_MISMATCH",
    InsufficientDeposit => "INSUFFICIENT_DEPOSIT",
    Overflow => "OVERFLOW",
    // Mandate creation.
    InvalidAgent => "INVALID_AGENT",
    InvalidPayees => "INVALID_PAYEES",
    InvalidToken => "INVALID_TOKEN",
    InvalidLimits => "INVALID_LIMITS",
    InvalidPurposeHash => "INVALID_PURPOSE_HASH",
    InvalidExpiry => "INVALID_EXPIRY",
    InvalidQuotas => "INVALID_QUOTAS",
}

#[cfg(test)]
mod tests {
    use super::Reason;
    use std::collections::HashSet;

    #[test]
    fn codes_are_unique_and_upper_snake() {
        let mut seen = HashSet::new();
        for reason in Reason::ALL {
            let code = reason.code();
            assert!(seen.insert(code), "duplicate {code}");
            assert!(
                code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'),
                "{code}"
            );
        }
    }
}
