use std::collections::{HashMap, HashSet};

use proptest::prelude::*;
use provingground_core::*;

const NOW: u64 = 1_000 * 86_400_000_000_000;
const EXPIRY: u64 = NOW + 86_400_000_000_000;
const TTL: u64 = 3_600_000_000_000;
const CHECK_COST: u128 = 5;
const STORAGE_COST: u128 = 7;
const HASH: &str = "ab00000000000000000000000000000000000000000000000000000000000000";
const PURPOSE: &str = "cd00000000000000000000000000000000000000000000000000000000000000";

#[derive(Default)]
struct Book {
    cap: Option<u128>,
    used: HashMap<u64, u128>,
    invoices: HashSet<[u8; 32]>,
}

impl Ledger for Book {
    fn daily_cap(&self, _: &Mandate) -> Option<u128> {
        self.cap
    }
    fn daily_used(&self, _: &Mandate, day: u64) -> u128 {
        self.used.get(&day).copied().unwrap_or(0)
    }
    fn invoice_used(&self, _: &Mandate, hash: &[u8; 32]) -> bool {
        self.invoices.contains(hash)
    }
}

fn book() -> Book {
    Book {
        cap: Some(500),
        ..Book::default()
    }
}

fn mandate() -> Mandate {
    let payees = vec!["acme.testnet".to_string(), "globex.testnet".to_string()];
    let mut mandate = validate_new_mandate(
        1,
        &NewMandate {
            owner: "owner.testnet",
            agent: "agent.testnet",
            payees: &payees,
            token: None,
            max_total: "1000",
            max_per_payment: "100",
            purpose_hash: PURPOSE,
            expires_at: EXPIRY,
            max_requests: 10,
            max_checks_per_day: 5,
            park_ttl: TTL,
        },
        NOW,
    )
    .unwrap();
    mandate.balance = 1000;
    mandate.checker_budget = 1000;
    mandate.storage_balance = 1000;
    mandate
}

fn input() -> PaymentInput<'static> {
    PaymentInput {
        caller: "agent.testnet",
        gas_sufficient: true,
        attached_deposit: 0,
        payee: "acme.testnet",
        amount: "100",
        invoice_hash: HASH,
        blob_ref: "blob-1",
        memo: "invoice 1",
    }
}

fn check(input: PaymentInput, mandate: &Mandate, book: &Book) -> Result<Accepted, Reason> {
    evaluate(&input, Some(mandate), NOW, CHECK_COST, STORAGE_COST, book)
}

fn refused(input: PaymentInput, mandate: &Mandate, book: &Book) -> Reason {
    check(input, mandate, book).unwrap_err()
}

fn request(status: PaymentStatus) -> PaymentRequest {
    PaymentRequest {
        id: 1,
        mandate_id: 1,
        payee: "acme.testnet".into(),
        amount: 100,
        invoice_hash: [0; 32],
        blob_ref: String::new(),
        memo: String::new(),
        status,
        reason: Reason::CheckerWarn,
        created_at: NOW,
        updated_at: NOW,
        day: day_of(NOW),
    }
}

#[test]
fn valid_request_is_accepted() {
    let accepted = check(input(), &mandate(), &book()).unwrap();
    assert_eq!(accepted.amount, 100);
    assert_eq!(accepted.invoice_hash[0], 0xab);
}

#[test]
fn gas_too_low() {
    let i = PaymentInput {
        gas_sufficient: false,
        ..input()
    };
    assert_eq!(refused(i, &mandate(), &book()), Reason::GasTooLow);
}

#[test]
fn deposit_not_allowed() {
    let i = PaymentInput {
        attached_deposit: 1,
        ..input()
    };
    assert_eq!(refused(i, &mandate(), &book()), Reason::DepositNotAllowed);
}

#[test]
fn input_too_large() {
    let long = "x".repeat(1_000);
    let (m, b) = (mandate(), book());
    assert_eq!(
        refused(
            PaymentInput {
                payee: &long,
                ..input()
            },
            &m,
            &b
        ),
        Reason::InputTooLarge
    );
    assert_eq!(
        refused(
            PaymentInput {
                amount: &long,
                ..input()
            },
            &m,
            &b
        ),
        Reason::InputTooLarge
    );
    assert_eq!(
        refused(
            PaymentInput {
                invoice_hash: &long,
                ..input()
            },
            &m,
            &b
        ),
        Reason::InputTooLarge
    );
    assert_eq!(
        refused(
            PaymentInput {
                blob_ref: &long,
                ..input()
            },
            &m,
            &b
        ),
        Reason::InputTooLarge
    );
    assert_eq!(
        refused(
            PaymentInput {
                memo: &long,
                ..input()
            },
            &m,
            &b
        ),
        Reason::InputTooLarge
    );
}

#[test]
fn amount_invalid() {
    let (m, b) = (mandate(), book());
    for amount in [
        "",
        "0",
        "-1",
        "+1",
        "1.5",
        "1e3",
        "0x10",
        " 1",
        "abc",
        "١٠",
        "340282366920938463463374607431768211456",
    ] {
        assert_eq!(
            refused(PaymentInput { amount, ..input() }, &m, &b),
            Reason::AmountInvalid,
            "{amount:?}"
        );
    }
}

#[test]
fn invoice_hash_invalid() {
    let (m, b) = (mandate(), book());
    let upper = HASH.to_uppercase();
    let not_hex = "z".repeat(64);
    for invoice_hash in ["", "ab", upper.as_str(), not_hex.as_str(), &HASH[..63]] {
        assert_eq!(
            refused(
                PaymentInput {
                    invoice_hash,
                    ..input()
                },
                &m,
                &b
            ),
            Reason::InvoiceHashInvalid,
            "{invoice_hash:?}"
        );
    }
}

#[test]
fn mandate_not_found() {
    let result = evaluate(&input(), None, NOW, CHECK_COST, STORAGE_COST, &book());
    assert_eq!(result.unwrap_err(), Reason::MandateNotFound);
}

#[test]
fn not_agent() {
    let i = PaymentInput {
        caller: "attacker.testnet",
        ..input()
    };
    assert_eq!(refused(i, &mandate(), &book()), Reason::NotAgent);
}

#[test]
fn revoked_closed_and_expired() {
    let mut m = mandate();
    m.status = MandateStatus::Revoked;
    assert_eq!(refused(input(), &m, &book()), Reason::MandateRevoked);
    m.status = MandateStatus::Closed;
    assert_eq!(refused(input(), &m, &book()), Reason::MandateClosed);
    let mut m = mandate();
    m.expires_at = NOW;
    assert_eq!(refused(input(), &m, &book()), Reason::MandateExpired);
}

#[test]
fn lookalike_payees_are_invalid() {
    let (m, b) = (mandate(), book());
    for payee in [
        "аcme.testnet",
        "acme.testnеt",
        "ACME.testnet",
        "acme\u{200b}.testnet",
        "a",
    ] {
        assert_eq!(
            refused(PaymentInput { payee, ..input() }, &m, &b),
            Reason::PayeeInvalid,
            "{payee:?}"
        );
    }
}

#[test]
fn near_miss_payees_are_not_allowed() {
    let (m, b) = (mandate(), book());
    for payee in [
        "acme-pay.testnet",
        "acmee.testnet",
        "pay.acme.testnet",
        "acme.near",
        "attacker.testnet",
        "owner.testnet",
    ] {
        assert_eq!(
            refused(PaymentInput { payee, ..input() }, &m, &b),
            Reason::PayeeNotAllowed,
            "{payee:?}"
        );
    }
}

#[test]
fn limits_are_exact() {
    let (m, b) = (mandate(), book());
    assert!(check(
        PaymentInput {
            amount: "100",
            ..input()
        },
        &m,
        &b
    )
    .is_ok());
    assert_eq!(
        refused(
            PaymentInput {
                amount: "101",
                ..input()
            },
            &m,
            &b
        ),
        Reason::OverPerPayment
    );
}

#[test]
fn over_total_counts_spent_and_reserved() {
    let mut m = mandate();
    m.spent = 850;
    m.balance = 10_000;
    m.reserved = 100;
    assert!(check(
        PaymentInput {
            amount: "50",
            ..input()
        },
        &m,
        &book()
    )
    .is_ok());
    assert_eq!(
        refused(
            PaymentInput {
                amount: "51",
                ..input()
            },
            &m,
            &book()
        ),
        Reason::OverTotal
    );
}

#[test]
fn insufficient_balance_counts_reserved() {
    let mut m = mandate();
    m.balance = 150;
    m.reserved = 100;
    assert!(check(
        PaymentInput {
            amount: "50",
            ..input()
        },
        &m,
        &book()
    )
    .is_ok());
    assert_eq!(
        refused(
            PaymentInput {
                amount: "51",
                ..input()
            },
            &m,
            &book()
        ),
        Reason::InsufficientBalance
    );
}

#[test]
fn daily_cap() {
    let m = mandate();
    let unset = Book::default();
    assert_eq!(refused(input(), &m, &unset), Reason::DailyCapUnset);

    let mut b = book();
    b.used.insert(day_of(NOW), 450);
    assert!(check(
        PaymentInput {
            amount: "50",
            ..input()
        },
        &m,
        &b
    )
    .is_ok());
    assert_eq!(
        refused(
            PaymentInput {
                amount: "51",
                ..input()
            },
            &m,
            &b
        ),
        Reason::OverDailyCap
    );

    let mut yesterday = book();
    yesterday.used.insert(day_of(NOW) - 1, 500);
    assert!(check(input(), &m, &yesterday).is_ok());
}

#[test]
fn replay() {
    let m = mandate();
    let mut b = book();
    let accepted = check(input(), &m, &b).unwrap();
    b.invoices.insert(accepted.invoice_hash);
    assert_eq!(refused(input(), &m, &b), Reason::Replay);
}

#[test]
fn request_limit() {
    let mut m = mandate();
    m.requests_stored = m.max_requests;
    assert_eq!(refused(input(), &m, &book()), Reason::RequestLimit);
    let mut m = mandate();
    m.storage_balance = STORAGE_COST - 1;
    assert_eq!(refused(input(), &m, &book()), Reason::RequestLimit);
}

#[test]
fn check_limit_resets_each_day() {
    let mut m = mandate();
    m.checks_day = day_of(NOW);
    m.checks_today = m.max_checks_per_day;
    assert_eq!(refused(input(), &m, &book()), Reason::CheckLimit);
    m.checks_day = day_of(NOW) - 1;
    assert!(check(input(), &m, &book()).is_ok());
}

#[test]
fn checker_budget_exhausted() {
    let mut m = mandate();
    m.checker_budget = CHECK_COST - 1;
    assert_eq!(
        refused(input(), &m, &book()),
        Reason::CheckerBudgetExhausted
    );
}

#[test]
fn rules_run_in_documented_order() {
    let mut m = mandate();
    m.status = MandateStatus::Revoked;
    let bad = PaymentInput {
        caller: "attacker.testnet",
        payee: "attacker.testnet",
        ..input()
    };
    assert_eq!(refused(bad, &m, &book()), Reason::NotAgent);
    let bad = PaymentInput {
        payee: "attacker.testnet",
        ..input()
    };
    assert_eq!(refused(bad, &m, &book()), Reason::MandateRevoked);
    let bad = PaymentInput {
        payee: "attacker.testnet",
        amount: "101",
        ..input()
    };
    assert_eq!(refused(bad, &mandate(), &book()), Reason::PayeeNotAllowed);
}

#[test]
fn second_request_cannot_spend_a_reserved_budget() {
    let mut m = mandate();
    m.max_total = 150;
    m.balance = 150;
    let b = book();
    let first = check(input(), &m, &b).unwrap();
    m.reserve(first.amount, day_of(NOW), CHECK_COST, STORAGE_COST)
        .unwrap();
    assert_eq!(refused(input(), &m, &b), Reason::OverTotal);
}

#[test]
fn reserve_refuses_what_rules_would_refuse() {
    let mut m = mandate();
    let before = m.clone();
    assert_eq!(m.reserve(1001, 1, 0, 0), Err(Reason::OverTotal));
    m.max_total = 5000;
    assert_eq!(m.reserve(1001, 1, 0, 0), Err(Reason::InsufficientBalance));
    m.max_total = before.max_total;
    assert_eq!(
        m.reserve(1, 1, 1001, 0),
        Err(Reason::CheckerBudgetExhausted)
    );
    assert_eq!(m.reserve(1, 1, 0, 1001), Err(Reason::RequestLimit));
    assert_eq!(m, before);
}

#[test]
fn new_mandate_validation() {
    let good = vec!["acme.testnet".to_string()];
    let empty: Vec<String> = vec![];
    let bad_payee = vec!["ACME".to_string()];
    let too_many: Vec<String> = (0..17).map(|i| format!("p{i}.testnet")).collect();
    let base = NewMandate {
        owner: "owner.testnet",
        agent: "agent.testnet",
        payees: &good,
        token: None,
        max_total: "10",
        max_per_payment: "5",
        purpose_hash: PURPOSE,
        expires_at: EXPIRY,
        max_requests: 1,
        max_checks_per_day: 1,
        park_ttl: TTL,
    };
    let result = |new: NewMandate| validate_new_mandate(1, &new, NOW).map(|_| ()).unwrap_err();

    assert!(validate_new_mandate(1, &base, NOW).is_ok());
    assert_eq!(
        result(NewMandate {
            agent: "BAD",
            ..base.clone()
        }),
        Reason::InvalidAgent
    );
    assert_eq!(
        result(NewMandate {
            payees: &empty,
            ..base.clone()
        }),
        Reason::InvalidPayees
    );
    assert_eq!(
        result(NewMandate {
            payees: &bad_payee,
            ..base.clone()
        }),
        Reason::InvalidPayees
    );
    assert_eq!(
        result(NewMandate {
            payees: &too_many,
            ..base.clone()
        }),
        Reason::InvalidPayees
    );
    assert_eq!(
        result(NewMandate {
            token: Some("BAD"),
            ..base.clone()
        }),
        Reason::InvalidToken
    );
    assert_eq!(
        result(NewMandate {
            max_total: "0",
            ..base.clone()
        }),
        Reason::InvalidLimits
    );
    assert_eq!(
        result(NewMandate {
            max_per_payment: "x",
            ..base.clone()
        }),
        Reason::InvalidLimits
    );
    assert_eq!(
        result(NewMandate {
            max_per_payment: "11",
            ..base.clone()
        }),
        Reason::InvalidLimits
    );
    assert_eq!(
        result(NewMandate {
            purpose_hash: "short",
            ..base.clone()
        }),
        Reason::InvalidPurposeHash
    );
    assert_eq!(
        result(NewMandate {
            expires_at: NOW,
            ..base.clone()
        }),
        Reason::InvalidExpiry
    );
    assert_eq!(
        result(NewMandate {
            max_requests: 0,
            ..base.clone()
        }),
        Reason::InvalidQuotas
    );
    assert_eq!(
        result(NewMandate {
            max_requests: MAX_REQUESTS + 1,
            ..base.clone()
        }),
        Reason::InvalidQuotas
    );
    assert_eq!(
        result(NewMandate {
            max_checks_per_day: 0,
            ..base.clone()
        }),
        Reason::InvalidQuotas
    );
    assert_eq!(
        result(NewMandate {
            park_ttl: 0,
            ..base.clone()
        }),
        Reason::InvalidQuotas
    );
    assert_eq!(
        result(NewMandate {
            park_ttl: MAX_PARK_TTL_NS + 1,
            ..base.clone()
        }),
        Reason::InvalidQuotas
    );
}

#[test]
fn verdicts_map_to_next_steps() {
    let (r, m) = (request(PaymentStatus::Checking), mandate());
    let next = |outcome| after_verdict(&r, &m, NOW, &outcome).unwrap();
    assert_eq!(
        next(CheckerOutcome::Allow(vec![])),
        Next::Pay(Reason::CheckerAllow)
    );
    assert_eq!(
        next(CheckerOutcome::Warn(vec![])),
        Next::Park(Reason::CheckerWarn)
    );
    assert_eq!(
        next(CheckerOutcome::Block(vec![])),
        Next::Block(Reason::CheckerBlock)
    );
    assert_eq!(
        next(CheckerOutcome::Unavailable),
        Next::Park(Reason::CheckerUnavailable)
    );
    assert_eq!(
        next(CheckerOutcome::BadOutput),
        Next::Park(Reason::CheckerBadOutput)
    );
}

#[test]
fn allow_cannot_pay_a_revoked_or_expired_mandate() {
    let r = request(PaymentStatus::Checking);
    let allow = CheckerOutcome::Allow(vec![]);
    let mut m = mandate();
    m.status = MandateStatus::Revoked;
    assert_eq!(
        after_verdict(&r, &m, NOW, &allow),
        Ok(Next::Block(Reason::MandateRevoked))
    );
    m.status = MandateStatus::Closed;
    assert_eq!(
        after_verdict(&r, &m, NOW, &allow),
        Ok(Next::Block(Reason::MandateClosed))
    );
    assert_eq!(
        after_verdict(&r, &mandate(), EXPIRY, &allow),
        Ok(Next::Block(Reason::MandateExpired))
    );
}

#[test]
fn late_verdict_changes_nothing() {
    let m = mandate();
    let allow = CheckerOutcome::Allow(vec![]);
    for status in [
        PaymentStatus::Parked,
        PaymentStatus::Paying,
        PaymentStatus::Paid,
        PaymentStatus::Blocked,
        PaymentStatus::Rejected,
        PaymentStatus::Failed,
    ] {
        assert_eq!(
            after_verdict(&request(status), &m, NOW, &allow),
            Err(Reason::BadRequestState),
            "{status:?}"
        );
    }
}

#[test]
fn approve_rechecks_the_mandate() {
    let (r, owner) = (request(PaymentStatus::Parked), "owner.testnet");
    assert_eq!(approve_check(&r, &mandate(), owner, NOW), Ok(()));
    assert_eq!(
        approve_check(&r, &mandate(), "agent.testnet", NOW),
        Err(Reason::NotOwner)
    );
    assert_eq!(
        approve_check(&request(PaymentStatus::Paid), &mandate(), owner, NOW),
        Err(Reason::BadRequestState)
    );
    assert_eq!(
        approve_check(&request(PaymentStatus::Checking), &mandate(), owner, NOW),
        Err(Reason::BadRequestState)
    );
    let mut m = mandate();
    m.status = MandateStatus::Revoked;
    assert_eq!(
        approve_check(&r, &m, owner, NOW),
        Err(Reason::MandateRevoked)
    );
    m.status = MandateStatus::Closed;
    assert_eq!(
        approve_check(&r, &m, owner, NOW),
        Err(Reason::MandateClosed)
    );
    assert_eq!(
        approve_check(&r, &mandate(), owner, EXPIRY),
        Err(Reason::MandateExpired)
    );
    assert_eq!(
        approve_check(&r, &mandate(), owner, NOW + TTL),
        Err(Reason::ParkExpired)
    );
}

#[test]
fn reject_is_owner_only_and_parked_only() {
    let (r, m) = (request(PaymentStatus::Parked), mandate());
    assert_eq!(reject_check(&r, &m, "owner.testnet"), Ok(()));
    assert_eq!(reject_check(&r, &m, "agent.testnet"), Err(Reason::NotOwner));
    assert_eq!(
        reject_check(&request(PaymentStatus::Paying), &m, "owner.testnet"),
        Err(Reason::BadRequestState)
    );
}

#[test]
fn stale_release() {
    const TIMEOUT: u64 = 1_000;
    let m = mandate();
    let parked = request(PaymentStatus::Parked);
    assert_eq!(
        stale_check(&parked, &m, NOW, TIMEOUT),
        Err(Reason::NotStale)
    );
    assert_eq!(
        stale_check(&parked, &m, NOW + TTL, TIMEOUT),
        Ok(Stale::RejectParked)
    );
    let checking = request(PaymentStatus::Checking);
    assert_eq!(
        stale_check(&checking, &m, NOW, TIMEOUT),
        Err(Reason::NotStale)
    );
    assert_eq!(
        stale_check(&checking, &m, NOW + TIMEOUT, TIMEOUT),
        Ok(Stale::FailChecking)
    );
    for status in [
        PaymentStatus::Paying,
        PaymentStatus::Paid,
        PaymentStatus::Blocked,
        PaymentStatus::Rejected,
        PaymentStatus::Failed,
    ] {
        assert_eq!(
            stale_check(&request(status), &m, u64::MAX, TIMEOUT),
            Err(Reason::BadRequestState),
            "{status:?}"
        );
    }
}

#[test]
fn withdraw_leaves_reserved_funds() {
    let mut m = mandate();
    m.reserve(100, 1, 0, 0).unwrap();
    assert_eq!(m.withdraw(901), Err(Reason::OverWithdrawable));
    assert_eq!(m.withdraw(0), Err(Reason::OverWithdrawable));
    m.withdraw(900).unwrap();
    assert_eq!(m.balance, 100);
    assert_eq!(m.reserved, 100);
}

#[derive(Clone, Debug)]
enum Op {
    Reserve(u128),
    ReleaseOldest,
    PayOldest,
    Fund(u128),
    Withdraw(u128),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u128..300).prop_map(Op::Reserve),
        Just(Op::ReleaseOldest),
        Just(Op::PayOldest),
        (0u128..500).prop_map(Op::Fund),
        (0u128..500).prop_map(Op::Withdraw),
    ]
}

proptest! {
    #[test]
    fn budget_invariants_hold_for_any_sequence(ops in prop::collection::vec(op(), 0..200)) {
        let mut m = mandate();
        let b = book();
        let mut in_flight: Vec<u128> = vec![];

        for op in ops {
            match op {
                Op::Reserve(amount) => {
                    let text = amount.to_string();
                    let i = PaymentInput { amount: &text, ..input() };
                    m.checks_today = 0;
                    m.requests_stored = 0;
                    if check(i, &m, &b).is_ok() {
                        m.reserve(amount, day_of(NOW), 0, 0).unwrap();
                        in_flight.push(amount);
                    }
                }
                Op::ReleaseOldest => {
                    if !in_flight.is_empty() {
                        m.release(in_flight.remove(0)).unwrap();
                    }
                }
                Op::PayOldest => {
                    if !in_flight.is_empty() {
                        let spent_before = m.spent;
                        let amount = in_flight.remove(0);
                        m.settle_paid(amount).unwrap();
                        prop_assert_eq!(m.spent, spent_before + amount);
                    }
                }
                Op::Fund(amount) => m.fund(amount).unwrap(),
                Op::Withdraw(amount) => {
                    let _ = m.withdraw(amount);
                }
            }
            prop_assert!(m.invariants_hold(), "{m:?}");
            prop_assert_eq!(m.reserved, in_flight.iter().sum::<u128>());
            prop_assert!(m.spent <= m.max_total);
        }
    }

    #[test]
    fn arbitrary_inputs_never_panic(
        caller in ".{0,80}",
        payee in ".{0,200}",
        amount in ".{0,80}",
        invoice_hash in ".{0,150}",
        memo in ".{0,300}",
    ) {
        let i = PaymentInput {
            caller: &caller,
            payee: &payee,
            amount: &amount,
            invoice_hash: &invoice_hash,
            memo: &memo,
            ..input()
        };
        if let Ok(accepted) = check(i, &mandate(), &book()) {
            prop_assert!(accepted.amount <= 100);
            prop_assert!(payee == "acme.testnet" || payee == "globex.testnet");
            prop_assert_eq!(caller, "agent.testnet");
        }
    }

    #[test]
    fn checker_output_never_pays_unless_exact(bytes in prop::collection::vec(any::<u8>(), 0..300)) {
        let outcome = parse_checker_output(&bytes, 7);
        prop_assert!(!matches!(outcome, CheckerOutcome::Allow(_)));
    }
}
