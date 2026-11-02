mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};

// ---------- Payment outcomes ----------

#[tokio::test]
async fn allow_pays_the_listed_payee_exactly() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;

    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.assert_budget(id, near(10), near(2), 0).await?;
    let decision = env.resolve(flight, Some(allow(1))).await?;

    assert_eq!(decision["decision"], "PAID");
    assert_eq!(env.balance(env.vendor.id()).await? - vendor_before, near(2));
    env.assert_budget(id, near(8), 0, near(2)).await?;
    assert_eq!(env.request(1).await?["status"], "Paid");
    Ok(())
}

#[tokio::test]
async fn the_attacker_is_refused_with_a_reason_and_an_event() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vault_before = env.balance(env.vault.id()).await?;
    let attacker_before = env.balance(env.attacker.id()).await?;

    let result = env
        .request_call(&env.agent, id, env.attacker.id().as_str(), near(1), &invoice(1))
        .transact()
        .await?;
    let decided = events(&result, "payment_decided");
    let decision: Value = result.into_result()?.json()?;

    assert_eq!(decision["decision"], "BLOCK");
    assert_eq!(decision["reason"], "PAYEE_NOT_ALLOWED");
    assert_eq!(decided[0]["data"][0]["layer"], "contract");
    assert_eq!(decided[0]["data"][0]["reason"], "PAYEE_NOT_ALLOWED");
    assert_eq!(env.request_count().await?, 0, "the checker must not run");
    assert_eq!(env.balance(env.attacker.id()).await?, attacker_before);
    assert!(env.balance(env.vault.id()).await? >= vault_before);
    env.assert_budget(id, near(10), 0, 0).await?;
    Ok(())
}

#[tokio::test]
async fn block_refuses_and_releases_budget_but_burns_the_invoice() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;

    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    let decision = env.resolve(flight, Some(block(1))).await?;
    assert_eq!(decision["reason"], "CHECKER_BLOCK");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    env.assert_budget(id, near(10), 0, 0).await?;

    // Re-submitting cannot re-roll the model's answer.
    let retry: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(2), &invoice(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(retry["reason"], "REPLAY");
    Ok(())
}

// ---------- WARN and owner review ----------

#[tokio::test]
async fn warn_parks_then_owner_approval_pays() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;

    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    let decision = env.resolve(flight, Some(warn(1))).await?;
    assert_eq!(decision["decision"], "PARK");
    assert_eq!(decision["reason"], "CHECKER_WARN");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    env.assert_budget(id, near(10), near(2), 0).await?;

    let decision = env.approve(&env.owner, 1).await?;
    assert_eq!(decision["decision"], "PAID");
    assert_eq!(env.balance(env.vendor.id()).await? - vendor_before, near(2));
    env.assert_budget(id, near(8), 0, near(2)).await?;
    Ok(())
}

#[tokio::test]
async fn parked_payment_rejected_by_owner_releases_budget() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.resolve(flight, Some(warn(1))).await?;

    let decision = env.reject(&env.owner, 1).await?;
    assert_eq!(decision["decision"], "REJECTED");
    env.assert_budget(id, near(10), 0, 0).await?;
    assert_eq!(env.request(1).await?["status"], "Rejected");
    assert_eq!(env.approve(&env.owner, 1).await?["reason"], "BAD_REQUEST_STATE");
    Ok(())
}

#[tokio::test]
async fn only_the_owner_can_review_or_manage() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.resolve(flight, Some(warn(1))).await?;

    for caller in [&env.agent, &env.attacker, &env.vendor] {
        assert_eq!(env.approve(caller, 1).await?["reason"], "NOT_OWNER");
        assert_eq!(env.reject(caller, 1).await?["reason"], "NOT_OWNER");
        assert_eq!(env.revoke(caller, id).await?["reason"], "NOT_OWNER");
        let withdraw = json!({"mandate_id": id.to_string(), "amount": near(1).to_string()});
        let result = env.owner_call(caller, "withdraw", withdraw, 1).await?;
        assert_eq!(result["reason"], "NOT_OWNER");
    }
    env.assert_budget(id, near(10), near(2), 0).await?;
    assert_eq!(env.request(1).await?["status"], "Parked");
    Ok(())
}

#[tokio::test]
async fn owner_calls_require_exactly_one_yocto() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.resolve(flight, Some(warn(1))).await?;
    let request = json!({"request_id": "1"});
    for (method, args) in [
        ("approve", request.clone()),
        ("reject", request),
        ("revoke", json!({"mandate_id": id.to_string()})),
        ("withdraw", json!({"mandate_id": id.to_string(), "amount": "1"})),
        ("close", json!({"mandate_id": id.to_string()})),
    ] {
        let result = env.owner_call(&env.owner, method, args, 0).await?;
        assert_eq!(result["reason"], "NEEDS_ONE_YOCTO", "{method}");
    }
    Ok(())
}

#[tokio::test]
async fn parked_payments_expire_and_can_be_released_by_anyone() -> TestResult {
    let env = Env::new().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["park_ttl"] = json!("1");
    let id = env.create(args, near(10)).await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.resolve(flight, Some(warn(1))).await?;
    env.worker.fast_forward(5).await?;

    assert_eq!(env.approve(&env.owner, 1).await?["reason"], "PARK_EXPIRED");
    let released: Value = env
        .attacker
        .call(env.vault.id(), "release_stale")
        .args_json(json!({"request_id": "1"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(released["reason"], "PARK_EXPIRED");
    env.assert_budget(id, near(10), 0, 0).await?;
    Ok(())
}

#[tokio::test]
async fn every_stage_leaves_its_reason() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;

    let flight = env.request_in_flight(id, near(1), &invoice(1)).await?;
    assert_eq!(env.request(1).await?["reason"], "RULES_PASSED");
    env.resolve(flight, Some(warn(1))).await?;
    let approved = env
        .owner
        .call(env.vault.id(), "approve")
        .args_json(json!({"request_id": "1"}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?;
    let decided = events(&approved, "payment_decided");
    assert_eq!(decided[0]["data"][0]["layer"], "owner");
    assert_eq!(decided[0]["data"][0]["reason"], "OWNER_APPROVED");
    assert_eq!(env.request(1).await?["reason"], "SETTLED");

    let flight = env.request_in_flight(id, near(1), &invoice(2)).await?;
    env.resolve(flight, Some(warn(2))).await?;
    env.reject(&env.owner, 2).await?;
    assert_eq!(env.request(2).await?["reason"], "OWNER_REJECTED");
    Ok(())
}

#[tokio::test]
async fn unknown_requests_and_short_deposits_are_refused() -> TestResult {
    let env = Env::new().await?;
    assert_eq!(env.approve(&env.owner, 999).await?["reason"], "REQUEST_NOT_FOUND");
    assert_eq!(env.reject(&env.owner, 999).await?["reason"], "REQUEST_NOT_FOUND");

    let args = json!({"agent": env.agent.id(), "token": null, "cap": "1"});
    let result = env.owner_call(&env.owner, "set_daily_cap", args.clone(), 2).await?;
    assert_eq!(result["reason"], "INSUFFICIENT_DEPOSIT");
    let result = env.owner_call(&env.owner, "set_daily_cap", args, 0).await?;
    assert_eq!(result["reason"], "NEEDS_ONE_YOCTO");

    let create = json!({"args": env.mandate_args(env.now().await?)});
    let result = env.owner_call(&env.owner, "create_mandate", create, near(1) / 10).await?;
    assert_eq!(result["reason"], "INSUFFICIENT_DEPOSIT");
    Ok(())
}

// ---------- Revoke and expiry mid-flow ----------

#[tokio::test]
async fn revoke_while_checking_stops_an_allow() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;

    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.revoke(&env.owner, id).await?;
    let decision = env.resolve(flight, Some(allow(1))).await?;

    assert_eq!(decision["decision"], "BLOCK");
    assert_eq!(decision["reason"], "MANDATE_REVOKED");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    env.assert_budget(id, near(10), 0, 0).await?;
    Ok(())
}

#[tokio::test]
async fn revoke_stops_parked_approval_and_new_requests() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    env.resolve(flight, Some(warn(1))).await?;
    env.revoke(&env.owner, id).await?;

    assert_eq!(env.approve(&env.owner, 1).await?["reason"], "MANDATE_REVOKED");
    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(2))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "MANDATE_REVOKED");

    // The owner can still recover the funds not held by the parked request.
    let withdraw = json!({"mandate_id": id.to_string(), "amount": near(8).to_string()});
    assert_eq!(env.owner_call(&env.owner, "withdraw", withdraw, 1).await?["decision"], "OK");
    env.assert_budget(id, near(2), near(2), 0).await?;
    assert_eq!(env.reject(&env.owner, 1).await?["decision"], "REJECTED");
    Ok(())
}

#[tokio::test]
async fn expired_mandate_refuses_requests_and_late_allows() -> TestResult {
    let env = Env::new().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["expires_at"] = json!((env.now().await? + 8_000_000_000).to_string());
    let id = env.create(args, near(10)).await?;
    let vendor_before = env.balance(env.vendor.id()).await?;

    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    tokio::time::sleep(std::time::Duration::from_secs(9)).await;

    let decision = env.resolve(flight, Some(allow(1))).await?;
    assert_eq!(decision["reason"], "MANDATE_EXPIRED");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);

    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(2))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "MANDATE_EXPIRED");
    Ok(())
}

// ---------- Races and replay ----------

#[tokio::test]
async fn racing_payments_cannot_both_spend_the_remaining_budget() -> TestResult {
    let env = Env::new().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["max_total"] = json!(near(3).to_string());
    let id = env.create(args, near(10)).await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    let vendor = env.vendor.id().as_str();

    // Sent back to back with no waiting. Exactly one can get the reservation.
    let first =
        env.request_call(&env.agent, id, vendor, near(2), &invoice(1)).transact_async().await?;
    let second =
        env.request_call(&env.agent, id, vendor, near(2), &invoice(2)).transact_async().await?;
    let flights = [first, second];

    env.wait_for_call(1).await?;
    env.worker.fast_forward(3).await?;
    env.assert_budget(id, near(10), near(2), 0).await?;
    assert_eq!(env.request_count().await?, 1, "only one may reach the checker");

    env.outlayer
        .call("resolve")
        .args_json(json!({"request_id": 1, "output": allow(1)}))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;
    let mut decisions = vec![];
    for flight in flights {
        decisions.push(InFlight { status: flight, checker_id: 1 }.finish().await?);
    }
    decisions.sort_by_key(|decision| decision["decision"].as_str().unwrap().to_string());
    assert_eq!(decisions[0]["decision"], "BLOCK");
    assert_eq!(decisions[0]["reason"], "OVER_TOTAL");
    assert_eq!(decisions[1]["decision"], "PAID");
    assert_eq!(env.balance(env.vendor.id()).await? - vendor_before, near(2));
    env.assert_budget(id, near(8), 0, near(2)).await?;
    Ok(())
}

#[tokio::test]
async fn same_invoice_cannot_race_itself() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(1), &invoice(1)).await?;
    let second: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(second["reason"], "REPLAY");
    env.resolve(flight, Some(allow(1))).await?;
    Ok(())
}

#[tokio::test]
async fn paid_invoice_cannot_be_replayed_through_another_mandate() -> TestResult {
    let env = Env::new().await?;
    let first = env.standard().await?;
    let second = env.standard().await?;
    let flight = env.request_in_flight(first, near(1), &invoice(1)).await?;
    env.resolve(flight, Some(allow(1))).await?;

    let vendor = env.vendor.id().as_str();
    for mandate in [first, second] {
        let decision: Value = env
            .request_call(&env.agent, mandate, vendor, near(1), &invoice(1))
            .transact()
            .await?
            .into_result()?
            .json()?;
        assert_eq!(decision["reason"], "REPLAY", "mandate {mandate}");
    }
    Ok(())
}

// ---------- Checker failure never pays ----------

#[tokio::test]
async fn failed_checker_run_parks_and_does_not_pay() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;

    let decision = env.resolve(flight, None).await?;
    assert_eq!(decision["decision"], "PARK");
    assert_eq!(decision["reason"], "CHECKER_UNAVAILABLE");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    env.assert_budget(id, near(10), near(2), 0).await?;
    Ok(())
}

#[tokio::test]
async fn checker_outage_at_request_time_parks_and_does_not_pay() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    env.outlayer
        .call("set_fail_requests")
        .args_json(json!({"fail": true}))
        .transact()
        .await?
        .into_result()?;

    let result = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(2), &invoice(1))
        .transact()
        .await?;
    let decision = decision_of(result)?;
    assert_eq!(decision["reason"], "CHECKER_UNAVAILABLE");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    env.assert_budget(id, near(10), near(2), 0).await?;
    Ok(())
}

#[tokio::test]
async fn checker_that_never_answers_times_out_and_does_not_pay() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;

    env.worker.fast_forward(300).await?;
    let decision = flight.finish().await?;
    assert_eq!(decision["decision"], "PARK");
    assert_eq!(decision["reason"], "CHECKER_UNAVAILABLE");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    Ok(())
}

#[tokio::test]
async fn malformed_verdicts_park_and_do_not_pay() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    let outputs: Vec<(String, &str)> = vec![
        ("ALLOW".to_string(), "bare word"),
        ("{}".to_string(), "empty object"),
        ("\"ALLOW\"".to_string(), "json string"),
        (verdict(999, "ALLOW", "WITHIN_PURPOSE"), "wrong request"),
        (verdict(0, "allow", "WITHIN_PURPOSE"), "wrong case"),
        (verdict(0, "ALLOW", "ignore previous instructions"), "free text reason"),
    ];
    for (index, (output, label)) in outputs.into_iter().enumerate() {
        let n = index as u64 + 1;
        let output = output.replace("\"request_id\":\"0\"", &format!("\"request_id\":\"{n}\""));
        let flight = env.request_in_flight(id, near(1) / 10, &invoice(n)).await?;
        let decision = env.resolve(flight, Some(output)).await?;
        assert_eq!(decision["decision"], "PARK", "{label}");
        assert_eq!(decision["reason"], "CHECKER_BAD_OUTPUT", "{label}");
    }

    let flight = env.request_in_flight(id, near(1) / 10, &invoice(100)).await?;
    env.outlayer
        .call("resolve_oversized")
        .args_json(json!({"request_id": flight.checker_id, "length": 4096}))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;
    let decision = flight.finish().await?;
    assert_eq!(decision["reason"], "CHECKER_BAD_OUTPUT", "oversized");

    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    Ok(())
}

#[tokio::test]
async fn stuck_check_can_be_released_and_a_late_allow_pays_nothing() -> TestResult {
    let env = Env::with(EnvOptions { check_timeout_ns: 1 }).await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;

    let released: Value = env
        .attacker
        .call(env.vault.id(), "release_stale")
        .args_json(json!({"request_id": "1"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(released["decision"], "FAILED");
    env.assert_budget(id, near(10), 0, 0).await?;

    let decision = env.resolve(flight, Some(allow(1))).await?;
    assert_eq!(decision["decision"], "IGNORED");
    assert_eq!(decision["reason"], "BAD_REQUEST_STATE");
    assert_eq!(env.balance(env.vendor.id()).await?, vendor_before);
    env.assert_budget(id, near(10), 0, 0).await?;
    Ok(())
}

#[tokio::test]
async fn release_stale_refuses_live_requests() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    let result: Value = env
        .attacker
        .call(env.vault.id(), "release_stale")
        .args_json(json!({"request_id": "1"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(result["reason"], "NOT_STALE");
    env.resolve(flight, Some(allow(1))).await?;
    Ok(())
}

#[tokio::test]
async fn callbacks_are_private() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;

    for (method, args) in [
        ("on_verdict", json!({"request_id": 1})),
        ("on_settled", json!({"request_id": 1})),
        ("on_withdraw_settled", json!({"mandate_id": id, "amount": near(1).to_string()})),
        (
            "on_close_settled",
            json!({"mandate_id": id, "checker_budget": "1", "storage_balance": "1"}),
        ),
    ] {
        let result = env
            .attacker
            .call(env.vault.id(), method)
            .args_json(args)
            .gas(MAX_GAS)
            .transact()
            .await?;
        assert!(result.is_failure(), "{method} must be private");
    }
    env.assert_budget(id, near(10), near(2), 0).await?;
    env.resolve(flight, Some(block(1))).await?;
    Ok(())
}

// ---------- Limits ----------

#[tokio::test]
async fn splitting_under_the_per_payment_cap_stops_at_the_total() -> TestResult {
    let env = Env::new().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["max_total"] = json!(near(5).to_string());
    let id = env.create(args, near(10)).await?;
    let vendor_before = env.balance(env.vendor.id()).await?;

    for n in 1..=2u64 {
        let flight = env.request_in_flight(id, near(2), &invoice(n)).await?;
        assert_eq!(env.resolve(flight, Some(allow(n))).await?["decision"], "PAID");
    }
    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(2), &invoice(3))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "OVER_TOTAL");
    assert_eq!(env.balance(env.vendor.id()).await? - vendor_before, near(4));
    Ok(())
}

#[tokio::test]
async fn daily_cap_is_shared_across_an_owners_mandates() -> TestResult {
    let env = Env::new().await?;
    let first = env.standard().await?;
    let second = env.standard().await?;
    env.set_cap(&env.owner, env.agent.id(), near(3)).await?;

    let flight = env.request_in_flight(first, near(2), &invoice(1)).await?;
    env.resolve(flight, Some(allow(1))).await?;
    let decision: Value = env
        .request_call(&env.agent, second, env.vendor.id().as_str(), near(2), &invoice(2))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "OVER_DAILY_CAP");

    let flight = env.request_in_flight(second, near(1), &invoice(3)).await?;
    env.resolve(flight, Some(block(2))).await?;
    let flight = env.request_in_flight(second, near(1), &invoice(4)).await?;
    assert_eq!(env.resolve(flight, Some(allow(3))).await?["decision"], "PAID");
    Ok(())
}

#[tokio::test]
async fn strangers_cannot_use_up_a_victims_daily_cap() -> TestResult {
    let env = Env::new().await?;
    let victim_mandate = env.standard().await?;
    env.set_cap(&env.owner, env.agent.id(), near(3)).await?;

    let mut args = env.mandate_args(env.now().await?);
    args["payees"] = json!([env.attacker.id()]);
    let stranger_mandate = env.create_as(&env.attacker, args, near(5)).await?;
    let flight = env
        .agent
        .call(env.vault.id(), "request_payment")
        .args_json(json!({
            "mandate_id": stranger_mandate.to_string(),
            "payee": env.attacker.id(),
            "amount": near(3).to_string(),
            "invoice_hash": invoice(1),
            "blob_ref": "",
            "memo": "",
        }))
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    env.wait_for_call(1).await?;
    let in_flight = InFlight { status: flight, checker_id: 1 };
    env.resolve(in_flight, Some(allow(1))).await?;

    let flight = env.request_in_flight(victim_mandate, near(3), &invoice(1)).await?;
    assert_eq!(env.resolve(flight, Some(allow(2))).await?["decision"], "PAID");
    Ok(())
}

#[tokio::test]
async fn no_daily_cap_means_no_payment() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let new_agent = env.worker.dev_create_account().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["agent"] = json!(new_agent.id());
    let result = env
        .owner
        .call(env.vault.id(), "create_mandate")
        .args_json(json!({"args": args}))
        .deposit(NearToken::from_near(3))
        .gas(MAX_GAS)
        .transact()
        .await?;
    let created: Value = result.into_result()?.json()?;
    let mandate = created["mandate_id"].as_str().unwrap();
    assert_ne!(mandate, id.to_string());
    let decision: Value = env
        .raw_request(&new_agent, mandate, env.vendor.id().as_str(), "1", &invoice(1), "", "")
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "DAILY_CAP_UNSET");
    Ok(())
}

#[tokio::test]
async fn check_quota_and_budget_stop_fee_burning() -> TestResult {
    let env = Env::new().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["max_checks_per_day"] = json!(2);
    let id = env.create(args, near(10)).await?;
    for n in 1..=2u64 {
        let flight = env.request_in_flight(id, near(1), &invoice(n)).await?;
        env.resolve(flight, Some(block(n))).await?;
    }
    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(3))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "CHECK_LIMIT");

    let mut args = env.mandate_args(env.now().await?);
    args["checker_budget"] = json!((FEE - 1).to_string());
    let poor = env.create(args, near(10)).await?;
    let decision: Value = env
        .request_call(&env.agent, poor, env.vendor.id().as_str(), near(1), &invoice(4))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "CHECKER_BUDGET_EXHAUSTED");
    Ok(())
}

#[tokio::test]
async fn request_count_limit_is_enforced() -> TestResult {
    let env = Env::new().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["max_requests"] = json!(1);
    let id = env.create(args, near(10)).await?;
    let flight = env.request_in_flight(id, near(1), &invoice(1)).await?;
    env.resolve(flight, Some(block(1))).await?;
    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(2))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "REQUEST_LIMIT");
    Ok(())
}

// ---------- Hostile input ----------

#[tokio::test]
async fn hostile_inputs_get_a_reason_code_and_never_panic() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let mandate = id.to_string();
    let vendor = env.vendor.id().to_string();
    let hash = invoice(1);
    let huge = "A".repeat(10_000);
    let lookalike = vendor.replacen('a', "а", 1);
    let sub_account = format!("pay.{vendor}");
    let squat = format!("{vendor}x");

    let cases: Vec<(&str, &str, &str, &str, &str, &str)> = vec![
        (&mandate, &huge, "1", &hash, "", ""),
        (&mandate, &vendor, &huge, &hash, "", ""),
        (&mandate, &vendor, "1", &huge, "", ""),
        (&mandate, &vendor, "1", &hash, &huge, ""),
        (&mandate, &vendor, "1", &hash, "", &huge),
        (&mandate, &vendor, "-1", &hash, "", ""),
        (&mandate, &vendor, "0", &hash, "", ""),
        (&mandate, &vendor, "1e24", &hash, "", ""),
        (&mandate, &vendor, "340282366920938463463374607431768211456", &hash, "", ""),
        (&mandate, &vendor, "1", "not-a-hash", "", ""),
        ("not-a-number", &vendor, "1", &hash, "", ""),
        ("99999", &vendor, "1", &hash, "", ""),
        (&mandate, &lookalike, "1", &hash, "", ""),
        (&mandate, "ATTACKER.TESTNET", "1", &hash, "", ""),
        (&mandate, "attacker\u{200b}.testnet", "1", &hash, "", ""),
        (&mandate, &sub_account, "1", &hash, "", ""),
        (&mandate, &squat, "1", &hash, "", ""),
    ];
    let expected = [
        "INPUT_TOO_LARGE",
        "INPUT_TOO_LARGE",
        "INPUT_TOO_LARGE",
        "INPUT_TOO_LARGE",
        "INPUT_TOO_LARGE",
        "AMOUNT_INVALID",
        "AMOUNT_INVALID",
        "AMOUNT_INVALID",
        "AMOUNT_INVALID",
        "INVOICE_HASH_INVALID",
        "MANDATE_NOT_FOUND",
        "MANDATE_NOT_FOUND",
        "PAYEE_INVALID",
        "PAYEE_INVALID",
        "PAYEE_INVALID",
        "PAYEE_NOT_ALLOWED",
        "PAYEE_NOT_ALLOWED",
    ];
    for ((mandate, payee, amount, hash, blob, memo), expected) in cases.into_iter().zip(expected) {
        let result = env
            .raw_request(&env.agent, mandate, payee, amount, hash, blob, memo)
            .transact()
            .await?;
        assert!(result.is_success(), "must not panic: {expected}");
        let logged = logs_of(&result).join("\n");
        assert!(!logged.contains("AAAAAAAAAA"), "logs must not repeat oversized input");
        assert_eq!(result.json::<Value>()?["reason"], expected);
    }
    assert_eq!(env.request_count().await?, 0);
    env.assert_budget(id, near(10), 0, 0).await?;
    Ok(())
}

#[tokio::test]
async fn low_gas_is_refused_before_anything_can_get_stuck() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(1))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "GAS_TOO_LOW");
    env.assert_budget(id, near(10), 0, 0).await?;
    Ok(())
}

#[tokio::test]
async fn minimum_gas_is_enough_to_finish_a_payment() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor_before = env.balance(env.vendor.id()).await?;
    let status = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(1))
        .gas(Gas::from_tgas(180))
        .transact_async()
        .await?;
    env.wait_for_call(1).await?;
    let decision = env.resolve(InFlight { status, checker_id: 1 }, Some(allow(1))).await?;
    assert_eq!(decision["decision"], "PAID");
    assert_eq!(env.balance(env.vendor.id()).await? - vendor_before, near(1));
    Ok(())
}

#[tokio::test]
async fn attached_deposit_is_refused_and_returned() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let agent_before = env.balance(env.agent.id()).await?;
    let vault_before = env.mandate(id).await?;
    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "DEPOSIT_NOT_ALLOWED");
    assert!(env.balance(env.agent.id()).await? + NEAR / 100 >= agent_before);
    assert_eq!(env.mandate(id).await?["balance"], vault_before["balance"]);
    Ok(())
}

#[tokio::test]
async fn other_accounts_cannot_use_the_mandate() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let vendor = env.vendor.id().as_str();
    for caller in [&env.attacker, &env.owner, &env.vendor] {
        let decision: Value = env
            .request_call(caller, id, vendor, near(1), &invoice(1))
            .transact()
            .await?
            .into_result()?
            .json()?;
        assert_eq!(decision["reason"], "NOT_AGENT");
    }
    Ok(())
}

#[tokio::test]
async fn cross_mandate_budget_confusion_is_refused() -> TestResult {
    let env = Env::new().await?;
    let vendor_b = env.worker.dev_create_account().await?;
    let a = env.standard().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["payees"] = json!([vendor_b.id()]);
    let b = env.create(args, 0).await?;

    let decision: Value = env
        .request_call(&env.agent, a, vendor_b.id().as_str(), near(1), &invoice(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "PAYEE_NOT_ALLOWED");
    let decision: Value = env
        .request_call(&env.agent, b, vendor_b.id().as_str(), near(1), &invoice(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "INSUFFICIENT_BALANCE");
    Ok(())
}

// ---------- Agent key limits ----------

#[tokio::test]
async fn function_call_key_can_only_request_payment() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let key =
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let scoped = near_workspaces::types::AccessKey::function_call_access(
        env.vault.id(),
        &["request_payment"],
        Some(NearToken::from_near(5)),
    );
    env.agent
        .batch(env.agent.id())
        .add_key(key.public_key(), scoped)
        .transact()
        .await?
        .into_result()?;
    let agent = near_workspaces::Account::from_secret_key(env.agent.id().clone(), key, &env.worker);
    let attacker_before = env.balance(env.attacker.id()).await?;

    // Moving NEAR directly.
    assert!(agent
        .transfer_near(env.attacker.id(), NearToken::from_near(1))
        .await
        .map_or(true, |r| r.is_failure()));
    // Calling any other method, or another contract.
    let approve = agent
        .call(env.vault.id(), "approve")
        .args_json(json!({"request_id": "1"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(approve.map_or(true, |r| r.is_failure()));
    let other = agent.call(env.outlayer.id(), "request_count").transact().await;
    assert!(other.map_or(true, |r| r.is_failure()));
    // Attaching a deposit, even to the allowed method.
    let paid = env
        .request_call(&agent, id, env.vendor.id().as_str(), near(1), &invoice(1))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(paid.map_or(true, |r| r.is_failure()));
    // Adding a full-access key.
    let extra =
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let add = agent
        .batch(env.agent.id())
        .add_key(extra.public_key(), near_workspaces::types::AccessKey::full_access())
        .transact()
        .await;
    assert!(add.map_or(true, |r| r.is_failure()));

    assert_eq!(env.balance(env.attacker.id()).await?, attacker_before);
    assert_eq!(env.request_count().await?, 0);

    // The one thing it can do still works.
    let status = env
        .request_call(&agent, id, env.vendor.id().as_str(), near(1), &invoice(1))
        .transact_async()
        .await?;
    env.wait_for_call(1).await?;
    let decision = env.resolve(InFlight { status, checker_id: 1 }, Some(allow(1))).await?;
    assert_eq!(decision["decision"], "PAID");
    Ok(())
}

// ---------- Transfers, funds and storage ----------

#[tokio::test]
async fn failed_transfer_releases_budget_and_keeps_the_money() -> TestResult {
    let env = Env::new().await?;
    let ghost = "ghost-account-does-not-exist.test.near";
    let mut args = env.mandate_args(env.now().await?);
    args["payees"] = json!([ghost]);
    let id = env.create(args, near(10)).await?;
    let vault_before = env.balance(env.vault.id()).await?;

    let status =
        env.request_call(&env.agent, id, ghost, near(2), &invoice(1)).transact_async().await?;
    env.wait_for_call(1).await?;
    let decision = env.resolve(InFlight { status, checker_id: 1 }, Some(allow(1))).await?;

    assert_eq!(decision["decision"], "FAILED");
    assert_eq!(decision["reason"], "TRANSFER_FAILED");
    env.assert_budget(id, near(10), 0, 0).await?;
    assert!(env.balance(env.vault.id()).await? + FEE + NEAR / 100 >= vault_before);

    // A failed transfer is a legitimate retry, so the invoice is usable again.
    let status =
        env.request_call(&env.agent, id, ghost, near(2), &invoice(1)).transact_async().await?;
    env.wait_for_call(2).await?;
    let decision = env.resolve(InFlight { status, checker_id: 2 }, Some(block(2))).await?;
    assert_eq!(decision["reason"], "CHECKER_BLOCK");
    Ok(())
}

#[tokio::test]
async fn withdraw_cannot_touch_reserved_funds() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    let too_much = json!({"mandate_id": id.to_string(), "amount": (near(8) + 1).to_string()});
    let result = env.owner_call(&env.owner, "withdraw", too_much, 1).await?;
    assert_eq!(result["reason"], "OVER_WITHDRAWABLE");

    let exact = json!({"mandate_id": id.to_string(), "amount": near(8).to_string()});
    assert_eq!(env.owner_call(&env.owner, "withdraw", exact, 1).await?["decision"], "OK");
    assert_eq!(env.resolve(flight, Some(allow(1))).await?["decision"], "PAID");
    env.assert_budget(id, 0, 0, near(2)).await?;
    Ok(())
}

#[tokio::test]
async fn close_requires_nothing_in_flight_and_refunds_budgets() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let close = json!({"mandate_id": id.to_string()});

    let flight = env.request_in_flight(id, near(2), &invoice(1)).await?;
    let result = env.owner_call(&env.owner, "close", close.clone(), 1).await?;
    assert_eq!(result["reason"], "REQUESTS_IN_FLIGHT");
    env.resolve(flight, Some(block(1))).await?;

    let result = env.owner_call(&env.owner, "close", close.clone(), 1).await?;
    assert_eq!(result["reason"], "MANDATE_NOT_EMPTY");
    let withdraw = json!({"mandate_id": id.to_string(), "amount": near(10).to_string()});
    env.owner_call(&env.owner, "withdraw", withdraw, 1).await?;

    let before = env.mandate(id).await?;
    let refund = before["checker_budget"].as_str().unwrap().parse::<u128>()?
        + before["storage_balance"].as_str().unwrap().parse::<u128>()?;
    let owner_before = env.balance(env.owner.id()).await?;
    let result = env.owner_call(&env.owner, "close", close, 1).await?;
    assert_eq!(result["decision"], "OK");
    assert!(env.balance(env.owner.id()).await? + NEAR / 100 >= owner_before + refund);
    let after = env.mandate(id).await?;
    assert_eq!(after["status"], "Closed");
    assert_eq!(after["checker_budget"], "0");
    assert_eq!(after["storage_balance"], "0");

    let decision: Value = env
        .request_call(&env.agent, id, env.vendor.id().as_str(), near(1), &invoice(9))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(decision["reason"], "MANDATE_CLOSED");
    Ok(())
}

#[tokio::test]
async fn refused_owner_calls_return_their_deposit() -> TestResult {
    let env = Env::new().await?;
    let vault_before = env.balance(env.vault.id()).await?;
    let attacker_before = env.balance(env.attacker.id()).await?;
    let mut args = env.mandate_args(env.now().await?);
    args["payees"] = json!([]);
    let result =
        env.owner_call(&env.attacker, "create_mandate", json!({"args": args}), near(5)).await?;
    assert_eq!(result["reason"], "INVALID_PAYEES");
    assert!(env.balance(env.attacker.id()).await? + NEAR / 100 >= attacker_before);
    assert!(env.balance(env.vault.id()).await? < vault_before + NEAR / 100);
    Ok(())
}

#[tokio::test]
async fn storage_charges_cover_what_is_actually_stored() -> TestResult {
    const REQUEST_STORAGE_BYTES: u64 = 1_200;
    const MANDATE_BASE_STORAGE_BYTES: u64 = 500;
    const DAILY_CAP_STORAGE_BYTES: u64 = 300;
    let env = Env::new().await?;
    let usage = |env: &Env| {
        let id = env.vault.id().clone();
        let worker = env.worker.clone();
        async move { Ok::<u64, Error>(worker.view_account(&id).await?.storage_usage) }
    };

    let before = usage(&env).await?;
    env.set_cap(&env.owner, env.agent.id(), near(20)).await?;
    let cap_bytes = usage(&env).await? - before;
    assert!(cap_bytes <= DAILY_CAP_STORAGE_BYTES, "cap used {cap_bytes}");

    let payees: Vec<String> = (0..16).map(|i| format!("{:064x}", i)).collect();
    let mut args = env.mandate_args(env.now().await?);
    args["payees"] = json!(payees);
    let before = usage(&env).await?;
    let id = env.create(args, near(10)).await?;
    let mandate_bytes = usage(&env).await? - before;
    let allowed = MANDATE_BASE_STORAGE_BYTES
        + payees.iter().map(|p| p.len() as u64 + 4).sum::<u64>()
        + env.owner.id().as_str().len() as u64
        + env.agent.id().as_str().len() as u64;
    assert!(mandate_bytes <= allowed, "mandate used {mandate_bytes}, charged for {allowed}");

    let before = usage(&env).await?;
    let memo = "m".repeat(256);
    let blob = "b".repeat(256);
    let status = env
        .raw_request(&env.agent, &id.to_string(), &payees[0], "1", &invoice(1), &blob, &memo)
        .transact_async()
        .await?;
    env.wait_for_call(1).await?;
    let in_flight = usage(&env).await? - before;
    assert!(in_flight <= REQUEST_STORAGE_BYTES, "first request used {in_flight}");
    env.resolve(InFlight { status, checker_id: 1 }, Some(block(1))).await?;
    Ok(())
}

// ---------- What the checker receives ----------

#[tokio::test]
async fn checker_call_is_pinned_and_carries_no_invoice_text() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    let owner_before = env.balance(env.owner.id()).await?;
    let status = env
        .raw_request(
            &env.agent,
            &id.to_string(),
            env.vendor.id().as_str(),
            &near(1).to_string(),
            &invoice(1),
            "blob-ref-1",
            "memo text",
        )
        .transact_async()
        .await?;
    env.wait_for_call(1).await?;

    let call: Value =
        env.outlayer.view("get_call").args_json(json!({"request_id": 1})).await?.json()?;
    assert_eq!(call["caller"], env.vault.id().as_str());
    assert_eq!(call["payer"], env.owner.id().as_str());
    assert_eq!(call["response_format"], "Json");
    assert_eq!(call["deposit"], FEE.to_string());
    assert_eq!(call["source"]["WasmUrl"]["hash"], "aa".repeat(32));
    let input: Value = serde_json::from_str(call["input_data"].as_str().unwrap())?;
    assert_eq!(input["v"], 1);
    assert_eq!(input["request_id"], "1");
    assert_eq!(input["payee"], env.vendor.id().as_str());
    assert_eq!(input["invoice_hash"], invoice(1));
    assert_eq!(input["blob_ref"], "blob-ref-1");
    assert_eq!(input["purpose_hash"], PURPOSE);
    let budget_after =
        env.mandate(id).await?["checker_budget"].as_str().unwrap().parse::<u128>()?;
    assert_eq!(budget_after, near(1) - FEE);

    env.resolve(InFlight { status, checker_id: 1 }, Some(block(1))).await?;
    assert!(
        env.balance(env.owner.id()).await? >= owner_before + FEE - NEAR / 1000,
        "unused fee goes to the owner"
    );
    Ok(())
}

#[tokio::test]
async fn history_views_list_each_mandates_requests() -> TestResult {
    let env = Env::new().await?;
    let id = env.standard().await?;
    for n in 1..=3u64 {
        let flight = env.request_in_flight(id, near(1), &invoice(n)).await?;
        env.resolve(flight, Some(block(n))).await?;
    }
    let list: Vec<Value> = env
        .vault
        .view("list_requests")
        .args_json(json!({"mandate_id": id.to_string(), "from_index": 1, "limit": 10}))
        .await?
        .json()?;
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["id"], "2");
    let used: bool = env
        .vault
        .view("is_invoice_used")
        .args_json(json!({"owner": env.owner.id(), "invoice_hash": invoice(1)}))
        .await?
        .json()?;
    assert!(used);
    Ok(())
}
