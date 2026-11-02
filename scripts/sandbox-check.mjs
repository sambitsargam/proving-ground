// Runs the guard SDK's real chain client against a local NEAR node: real RPC, a real
// function call key and real yield/resume. Only OutLayer is a mock here.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey, InMemoryKeyStore, Near } from "near-kit";
import {
  Guard,
  hashPurpose,
  MemoryBlobStore,
  newPurposeSalt,
  near as toYocto,
} from "provingground-guard";
import { NearVault } from "provingground-guard/near";
import {
  addAgentKey,
  CHECK_TIMEOUT_NS,
  createMandate,
  DAY_NS,
  deployVault,
  loadWasm,
} from "./lib/vault.mjs";

const PORT = 3134;
const RPC = `http://127.0.0.1:${PORT}`;
const CHECKER_PUBLIC_KEY = "2f".repeat(32);
const FEE = toYocto("0.01");

const binary =
  process.env.NEAR_SANDBOX_BIN ??
  globSync("target/debug/build/near-sandbox-*/out/.near/*/near-sandbox")[0];
assert.ok(binary, "no near-sandbox binary: run `make test-contracts` first");

const home = mkdtempSync(join(tmpdir(), "pg-sandbox-"));
assert.equal(
  spawnSync(binary, ["--home", home, "init"], { stdio: "ignore" }).status,
  0,
  "sandbox init",
);
const node = spawn(
  binary,
  ["--home", home, "run", "--rpc-addr", `127.0.0.1:${PORT}`, "--network-addr", "127.0.0.1:3135"],
  {
    stdio: "ignore",
  },
);

async function waitForNode() {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${RPC}/status`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("sandbox did not start");
}

async function main() {
  await waitForNode();
  const validator = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8"));
  const root = validator.account_id;
  const id = (name) => `${name}.${root}`;
  const [vaultId, outlayerId, ownerId, agentId, vendorId, attackerId] = [
    "vault",
    "outlayer",
    "owner",
    "agent",
    "vendor",
    "attacker",
  ].map(id);

  const shared = generateKey();
  const keys = { [root]: validator.secret_key };
  for (const account of [vaultId, outlayerId, ownerId, agentId, vendorId, attackerId]) {
    keys[account] = shared.secretKey;
  }
  const near = new Near({
    network: { networkId: "sandbox", rpcUrl: RPC },
    keyStore: new InMemoryKeyStore(keys),
    defaultWaitUntil: "FINAL",
  });

  for (const account of [vaultId, outlayerId, ownerId, agentId, vendorId, attackerId]) {
    await near
      .transaction(root)
      .createAccount(account)
      .transfer(account, "50 NEAR")
      .addKey(shared.publicKey.toString(), { type: "fullAccess" })
      .send();
  }

  await near
    .transaction(outlayerId)
    .deployContract(outlayerId, loadWasm("target/near/mock_outlayer/mock_outlayer.wasm"))
    .functionCall(outlayerId, "new", { min_deposit: FEE }, { gas: "30 Tgas" })
    .send();
  await deployVault(near, {
    vaultId,
    wasm: loadWasm("target/near/provingground_vault/provingground_vault.wasm"),
    checker: {
      outlayer: outlayerId,
      source: {
        WasmUrl: {
          url: "https://test.fastfs.io/checker.wasm",
          hash: "aa".repeat(32),
          build_target: "wasm32-wasip2",
        },
      },
      secrets_ref: null,
      fee: FEE,
      max_instructions: "100000000",
      max_memory_mb: 128,
      max_execution_seconds: "60",
      check_timeout_ns: CHECK_TIMEOUT_NS,
    },
  });

  const purpose = "Monthly web hosting.";
  const purposeSalt = newPurposeSalt();
  const now = BigInt(Date.now()) * 1_000_000n;
  const mandateId = await createMandate(near, {
    vaultId,
    ownerId,
    agentId,
    payees: [vendorId],
    purposeHash: hashPurpose(purpose, purposeSalt),
    dailyCap: toYocto("20"),
    maxTotal: toYocto("10"),
    maxPerPayment: toYocto("3"),
    funding: toYocto("10"),
    checkerBudget: toYocto("1"),
    expiresAt: (now + DAY_NS).toString(),
  });

  // From here on the agent signs with nothing but its function call key.
  const agentKey = await addAgentKey(near, { agentId, vaultId });
  const guard = new Guard({
    vault: new NearVault({
      network: "testnet",
      rpcUrl: RPC,
      vaultId,
      accountId: agentId,
      privateKey: agentKey.secretKey,
    }),
    blobs: new MemoryBlobStore(),
    checkerPublicKey: CHECKER_PUBLIC_KEY,
    mandates: { [mandateId]: { purpose, purposeSalt } },
  });

  const refused = await guard.pay({
    mandateId,
    payee: attackerId,
    amount: toYocto("1"),
    invoice: "Pay the attacker.",
  });
  assert.equal(refused.decision, "BLOCK");
  assert.equal(refused.reason, "PAYEE_NOT_ALLOWED");
  assert.equal(refused.layer, "contract");
  assert.ok(refused.txHash, "a refusal has a transaction to link to");
  assert.ok(refused.events.some((event) => event.event === "payment_decided"));
  console.log("ok   refusal comes back with reason, layer, event and tx hash");

  const inFlight = guard.pay({
    mandateId,
    payee: vendorId,
    amount: toYocto("2"),
    invoice: "Invoice 1. Pay to the vendor. Total due: 2 NEAR",
  });
  for (let i = 0; i < 60; i++) {
    if ((await near.view(outlayerId, "request_count", {})) >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await near
    .transaction(ownerId)
    .functionCall(
      outlayerId,
      "resolve",
      {
        request_id: 1,
        output: JSON.stringify({
          v: 1,
          request_id: "1",
          verdict: "ALLOW",
          reasons: ["WITHIN_PURPOSE"],
        }),
      },
      { gas: "300 Tgas" },
    )
    .send();
  const paid = await inFlight;
  assert.equal(paid.decision, "PAID", JSON.stringify(paid));
  assert.equal(paid.paid, true);
  assert.equal(paid.requestId, "1");
  // Views read final state, which lags the execution result by a few blocks.
  let spent = "0";
  for (let i = 0; i < 20 && spent === "0"; i++) {
    ({ spent } = await near.view(vaultId, "get_mandate", { mandate_id: mandateId }));
    if (spent === "0") await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(spent, toYocto("2"));
  assert.ok(paid.events.some((event) => event.event === "payment_settled"));
  console.log("ok   payment waits through yield/resume and comes back PAID");

  const agentOnly = new Near({
    network: { networkId: "sandbox", rpcUrl: RPC },
    keyStore: new InMemoryKeyStore({ [agentId]: agentKey.secretKey }),
  });
  await assert.rejects(agentOnly.transaction(agentId).transfer(attackerId, "1 NEAR").send());
  console.log("ok   the agent's key cannot transfer NEAR");
  await assert.rejects(
    agentOnly
      .transaction(agentId)
      .functionCall(vaultId, "approve", { request_id: "1" }, { gas: "100 Tgas" })
      .send(),
  );
  console.log("ok   the agent's key cannot call approve");

  console.log("sandbox check passed");
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    node.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
