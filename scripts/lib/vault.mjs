// Deployment steps shared by the local sandbox check and the testnet scripts.

import { readFileSync } from "node:fs";
import { generateKey } from "near-kit";

export const DAY_NS = 86_400_000_000_000n;
/** Longer than the 200 block yield timeout, as MANDATES.md requires. */
export const CHECK_TIMEOUT_NS = (10n * 60n * 1_000_000_000n).toString();

export function loadWasm(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url));
}

export function events(outcome) {
  return (outcome.receipts_outcome ?? [])
    .flatMap((receipt) => receipt.outcome.logs)
    .filter((log) => log.startsWith("EVENT_JSON:"))
    .map((log) => JSON.parse(log.slice("EVENT_JSON:".length)));
}

export function decisionOf(outcome) {
  const value = outcome.status?.SuccessValue;
  if (value === undefined) throw new Error(`call failed: ${JSON.stringify(outcome.status)}`);
  return value ? JSON.parse(Buffer.from(value, "base64").toString()) : null;
}

function expectOk(method, outcome) {
  const decision = decisionOf(outcome);
  if (decision && decision.decision !== "OK") {
    throw new Error(`${method} refused: ${JSON.stringify(decision)}`);
  }
  return decision;
}

export async function deployVault(near, { vaultId, wasm, checker }) {
  await near
    .transaction(vaultId)
    .deployContract(vaultId, wasm)
    .functionCall(vaultId, "new", { checker }, { gas: "100 Tgas" })
    .send();
}

/** Gives an agent its only key: it can call request_payment on this vault, nothing else. */
export async function addAgentKey(near, { agentId, vaultId, allowance = "1 NEAR" }) {
  const key = generateKey();
  await near
    .transaction(agentId)
    .addKey(key.publicKey.toString(), {
      type: "functionCall",
      receiverId: vaultId,
      methodNames: ["request_payment"],
      allowance,
    })
    .send();
  return key;
}

/** Owner's setup: daily cap, then a mandate funded with exactly `funding`. */
export async function createMandate(
  near,
  {
    vaultId,
    ownerId,
    agentId,
    payees,
    purposeHash,
    dailyCap,
    maxTotal,
    maxPerPayment,
    funding,
    checkerBudget,
    expiresAt,
    deposit = "4 NEAR",
    maxRequests = 20,
    maxChecksPerDay = 20,
    parkTtl = DAY_NS.toString(),
  },
) {
  expectOk(
    "set_daily_cap",
    await near
      .transaction(ownerId)
      .functionCall(
        vaultId,
        "set_daily_cap",
        { agent: agentId, token: null, cap: dailyCap },
        { gas: "30 Tgas", attachedDeposit: "0.1 NEAR" },
      )
      .send(),
  );
  const created = expectOk(
    "create_mandate",
    await near
      .transaction(ownerId)
      .functionCall(
        vaultId,
        "create_mandate",
        {
          args: {
            agent: agentId,
            payees,
            token: null,
            max_total: maxTotal,
            max_per_payment: maxPerPayment,
            purpose_hash: purposeHash,
            expires_at: expiresAt,
            max_requests: maxRequests,
            max_checks_per_day: maxChecksPerDay,
            park_ttl: parkTtl,
            checker_budget: checkerBudget,
          },
        },
        { gas: "100 Tgas", attachedDeposit: deposit },
      )
      .send(),
  );
  const mandateId = created.mandate_id;
  const { balance } = await near.view(vaultId, "get_mandate", { mandate_id: mandateId });
  if (BigInt(balance) > 0n) {
    expectOk(
      "withdraw",
      await near
        .transaction(ownerId)
        .functionCall(
          vaultId,
          "withdraw",
          { mandate_id: mandateId, amount: balance },
          { gas: "100 Tgas", attachedDeposit: "1 yocto" },
        )
        .send(),
    );
  }
  expectOk(
    "fund",
    await near
      .transaction(ownerId)
      .functionCall(
        vaultId,
        "fund",
        { mandate_id: mandateId },
        { gas: "30 Tgas", attachedDeposit: `${funding} yocto` },
      )
      .send(),
  );
  return mandateId;
}
