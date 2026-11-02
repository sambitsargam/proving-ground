mod common;

use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

async fn token(env: &Env) -> Result<Contract, Error> {
    let path =
        format!("{}/../../target/near/mock_token/mock_token.wasm", env!("CARGO_MANIFEST_DIR"));
    let token = env.worker.dev_deploy(&std::fs::read(path)?).await?;
    token.call("new").transact().await?.into_result()?;
    Ok(token)
}

async fn mint(token: &Contract, account: &str, amount: u128) -> TestResult {
    token
        .call("mint")
        .args_json(json!({"account_id": account, "amount": amount.to_string()}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn balance_of(token: &Contract, account: &str) -> Result<u128, Error> {
    let balance: String =
        token.view("ft_balance_of").args_json(json!({"account_id": account})).await?.json()?;
    Ok(balance.parse()?)
}

async fn fund(
    token: &Contract,
    sender: &Account,
    vault: &str,
    amount: u128,
    msg: &str,
) -> TestResult {
    sender
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": vault, "amount": amount.to_string(), "msg": msg}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn setup(env: &Env, token: &Contract) -> Result<u64, Error> {
    let vault = env.vault.id().as_str();
    for account in [vault, env.vendor.id().as_str()] {
        mint(token, account, 0).await?;
    }
    mint(token, env.owner.id().as_str(), 1_000).await?;

    env.owner
        .call(env.vault.id(), "set_daily_cap")
        .args_json(json!({"agent": env.agent.id(), "token": token.id(), "cap": "500"}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    let mut args = env.mandate_args(env.now().await?);
    args["token"] = json!(token.id());
    args["max_total"] = json!("300");
    args["max_per_payment"] = json!("100");
    let decision: Value = env
        .owner
        .call(env.vault.id(), "create_mandate")
        .args_json(json!({"args": args}))
        .deposit(NearToken::from_near(4))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = decision["mandate_id"].as_str().unwrap().parse()?;
    fund(token, &env.owner, vault, 200, &id.to_string()).await?;
    Ok(id)
}

#[tokio::test]
async fn token_payment_flow() -> TestResult {
    let env = Env::new().await?;
    let token = token(&env).await?;
    let id = setup(&env, &token).await?;
    env.assert_budget(id, 200, 0, 0).await?;

    let flight = env.request_in_flight(id, 60, &invoice(1)).await?;
    assert_eq!(env.resolve(flight, Some(allow(1))).await?["decision"], "PAID");
    assert_eq!(balance_of(&token, env.vendor.id().as_str()).await?, 60);
    env.assert_budget(id, 140, 0, 60).await?;

    // Parked and approved takes the same path.
    let flight = env.request_in_flight(id, 40, &invoice(2)).await?;
    env.resolve(flight, Some(warn(2))).await?;
    assert_eq!(env.approve(&env.owner, 2).await?["decision"], "PAID");
    assert_eq!(balance_of(&token, env.vendor.id().as_str()).await?, 100);
    env.assert_budget(id, 100, 0, 100).await?;

    let withdraw = json!({"mandate_id": id.to_string(), "amount": "100"});
    assert_eq!(env.owner_call(&env.owner, "withdraw", withdraw, 1).await?["decision"], "OK");
    assert_eq!(balance_of(&token, env.owner.id().as_str()).await?, 900);
    env.assert_budget(id, 0, 0, 100).await?;
    Ok(())
}

#[tokio::test]
async fn transfer_to_unregistered_payee_fails_safely() -> TestResult {
    let env = Env::new().await?;
    let token = token(&env).await?;
    let id = setup(&env, &token).await?;
    let unregistered = env.worker.dev_create_account().await?;
    let mut args = env.mandate_args(env.now().await?);
    args["token"] = json!(token.id());
    args["payees"] = json!([unregistered.id()]);
    args["max_total"] = json!("100");
    args["max_per_payment"] = json!("100");
    let decision: Value = env
        .owner
        .call(env.vault.id(), "create_mandate")
        .args_json(json!({"args": args}))
        .deposit(NearToken::from_near(4))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    let second: u64 = decision["mandate_id"].as_str().unwrap().parse()?;
    assert_ne!(second, id);
    fund(&token, &env.owner, env.vault.id().as_str(), 100, &second.to_string()).await?;

    let status = env
        .request_call(&env.agent, second, unregistered.id().as_str(), 50, &invoice(1))
        .transact_async()
        .await?;
    env.wait_for_call(1).await?;
    let decision = env.resolve(InFlight { status, checker_id: 1 }, Some(allow(1))).await?;
    assert_eq!(decision["decision"], "FAILED");
    env.assert_budget(second, 100, 0, 0).await?;
    assert_eq!(balance_of(&token, env.vault.id().as_str()).await?, 300);
    Ok(())
}

#[tokio::test]
async fn funding_is_refused_from_strangers_and_wrong_tokens() -> TestResult {
    let env = Env::new().await?;
    let real = token(&env).await?;
    let id = setup(&env, &real).await?;
    let vault = env.vault.id().as_str();

    // A stranger's tokens are returned, and do not count as funding.
    mint(&real, env.attacker.id().as_str(), 50).await?;
    fund(&real, &env.attacker, vault, 50, &id.to_string()).await?;
    assert_eq!(balance_of(&real, env.attacker.id().as_str()).await?, 50);
    env.assert_budget(id, 200, 0, 0).await?;

    // A worthless token cannot credit a mandate for a different token.
    let fake = self::token(&env).await?;
    mint(&fake, vault, 0).await?;
    mint(&fake, env.owner.id().as_str(), 1_000).await?;
    fund(&fake, &env.owner, vault, 1_000, &id.to_string()).await?;
    assert_eq!(balance_of(&fake, env.owner.id().as_str()).await?, 1_000);
    env.assert_budget(id, 200, 0, 0).await?;

    // Neither can calling the receiver hook directly.
    let unused: String = env
        .attacker
        .call(env.vault.id(), "ft_on_transfer")
        .args_json(json!({"sender_id": env.owner.id(), "amount": "1000", "msg": id.to_string()}))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(unused, "1000");
    env.assert_budget(id, 200, 0, 0).await?;

    // Bad messages are returned too.
    fund(&real, &env.owner, vault, 10, "not-a-mandate").await?;
    assert_eq!(balance_of(&real, env.owner.id().as_str()).await?, 800);
    Ok(())
}

#[tokio::test]
async fn native_funding_is_refused_on_a_token_mandate() -> TestResult {
    let env = Env::new().await?;
    let token = token(&env).await?;
    let id = setup(&env, &token).await?;
    let args = json!({"mandate_id": id.to_string()});
    let result = env.owner_call(&env.owner, "fund", args, near(1)).await?;
    assert_eq!(result["reason"], "TOKEN_MISMATCH");
    env.assert_budget(id, 200, 0, 0).await?;
    Ok(())
}
