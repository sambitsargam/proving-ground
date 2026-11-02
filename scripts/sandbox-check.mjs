// Runs all 25 attacks on a real NEAR node, with the real contract, real access keys and real
// yield/resume. Only OutLayer is a mock. Then it compares every result with mock mode, so the
// simulated runtime has to agree with the actual NEAR runtime on every attack.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { generateKey, InMemoryKeyStore, Near } from "near-kit";
import { runSuite, summaryLine } from "provingground";
import { ChainWorld, SandboxChecker } from "provingground/chain";
import { MemoryBlobStore, near as toYocto } from "provingground-guard";
import { NearVault } from "provingground-guard/near";
import { RPC, startSandbox } from "./lib/sandbox.mjs";
import { addAgentKey, CHECK_TIMEOUT_NS, deployVault, loadWasm } from "./lib/vault.mjs";

const FEE = toYocto("0.0105");
const FIELDS = ["layer", "decision", "reason", "checker_reasons", "stopped", "as_expected"];

const network = { networkId: "sandbox", rpcUrl: RPC };
const started = Date.now();
const seconds = () => Math.round((Date.now() - started) / 1000);

function x25519PublicKey(secretKey) {
  return import("node:crypto").then(({ createPrivateKey, createPublicKey }) =>
    createPublicKey(
      createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), secretKey]),
        format: "der",
        type: "pkcs8",
      }),
    )
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex"),
  );
}

async function main(sandbox) {
  const { root, rootKey } = sandbox;
  const names = ["vault", "outlayer", "owner", "agent", "vendor", "attacker", "driver"];
  const id = (name) => `${name}.${root}`;
  const shared = generateKey();
  const keys = Object.fromEntries(names.map((name) => [id(name), shared.secretKey]));
  const near = new Near({ network, keyStore: new InMemoryKeyStore({ ...keys, [root]: rootKey }) });

  for (const name of names) {
    await near
      .transaction(root)
      .createAccount(id(name))
      .transfer(id(name), "100 NEAR")
      .addKey(shared.publicKey.toString(), { type: "fullAccess" })
      .send();
  }
  await near
    .transaction(id("outlayer"))
    .deployContract(id("outlayer"), loadWasm("target/near/mock_outlayer/mock_outlayer.wasm"))
    .functionCall(id("outlayer"), "new", { min_deposit: FEE }, { gas: "30 Tgas" })
    .send();
  await deployVault(near, {
    vaultId: id("vault"),
    wasm: loadWasm("target/near/provingground_vault/provingground_vault.wasm"),
    checker: {
      outlayer: id("outlayer"),
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

  // The agent's account gets a function call key, and then loses its full-access key.
  const agentKey = await addAgentKey(near, { agentId: id("agent"), vaultId: id("vault") });
  await near.transaction(id("agent")).deleteKey(id("agent"), shared.publicKey.toString()).send();
  const agentNear = new Near({
    network,
    keyStore: new InMemoryKeyStore({ [id("agent")]: agentKey.secretKey }),
  });

  const blobs = new MemoryBlobStore();
  const secretKey = randomBytes(32);
  const control = new SandboxChecker({
    near,
    outlayerId: id("outlayer"),
    signerId: id("driver"),
    blobs: blobs.blobs,
    secretKey,
  });
  control.start();

  const setup = {
    near,
    agentNear,
    rpcUrl: RPC,
    vault: id("vault"),
    owner: id("owner"),
    agent: id("agent"),
    vendor: id("vendor"),
    attacker: id("attacker"),
    payroll: id("payroll"),
    vaultClient: new NearVault({
      network: "testnet",
      rpcUrl: RPC,
      vaultId: id("vault"),
      accountId: id("agent"),
      privateKey: agentKey.secretKey,
      pollIntervalMs: 100,
    }),
    blobs,
    checkerPublicKey: await x25519PublicKey(secretKey),
    control,
    runId: randomBytes(4).toString("hex"),
    recover: false,
    expiryMs: 2_000,
  };

  console.log(`${seconds()}s deployed`);
  const onChain = await runSuite({
    mode: "sandbox",
    makeWorld: () => ChainWorld.create(setup),
    onResult: (result) =>
      console.log(
        `${seconds()}s ${result.id} ${result.layer.padEnd(9)} ${result.decision.padEnd(9)} ${result.reason}`,
      ),
  });
  await control.stop();

  const mock = await runSuite();
  const differences = [];
  for (const [index, result] of onChain.results.entries()) {
    const other = mock.results[index];
    for (const field of FIELDS) {
      if (JSON.stringify(result[field]) !== JSON.stringify(other[field])) {
        differences.push(
          `${result.id} ${field}: node ${JSON.stringify(result[field])}, mock ${JSON.stringify(other[field])}`,
        );
      }
    }
  }
  for (const [index, limit] of onChain.known_limits.entries()) {
    const other = mock.known_limits[index];
    for (const field of ["paid_to_listed_yocto", "funds_lost_yocto", "stopped_by"]) {
      if (limit[field] !== other[field]) {
        differences.push(`${limit.id} ${field}: node ${limit[field]}, mock ${other[field]}`);
      }
    }
  }
  for (const difference of differences) console.log(`DIFFERENT ${difference}`);
  assert.equal(differences.length, 0, "the simulated runtime disagrees with a real node");

  // The network rejects key refusals before they run, and a panic has no decision to report.
  const noTx = (result) => result.layer === "key" || result.reason === "METHOD_IS_PRIVATE";
  assert.ok(onChain.results.every((result) => result.tx_hash || noTx(result)));
  console.log(`\nOn a real node: ${summaryLine(onChain).text}`);
  console.log(
    `Every result matches mock mode: ${onChain.results.length} attacks, ${onChain.known_limits.length} known limits.`,
  );
}

const sandbox = await startSandbox();
try {
  await main(sandbox);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  sandbox.stop();
}
// The checker's polling and the HTTP clients should not hold the process open.
process.exit(process.exitCode ?? 0);
