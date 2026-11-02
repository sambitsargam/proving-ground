// Deploys the vault to testnet and gives the agent its one key. Never prints a key.
// Needs CHECKER_WASM_URL in the environment, from `outlayer upload`. See docs/DEPLOY.md.

import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { sha256Hex } from "provingground-guard";
import { addAgentKey, CHECK_TIMEOUT_NS, deployVault, loadWasm } from "./lib/vault.mjs";

const OWNER = "provingground-owner.testnet";
const VAULT = "provingground-vault.testnet";
const AGENT = "provingground-agent.testnet";
const VENDOR = "provingground-vendor.testnet";
const ATTACKER = "provingground-attacker.testnet";
// Each request counts its prepaid gas against this, and it can never be topped up.
const AGENT_ALLOWANCE = "5 NEAR";
const OUTLAYER = "outlayer.testnet";
const SECRETS_PROFILE = "checker";
// Far above the 10M the checker needs, and well under OutLayer's 1B default.
const RESOURCE_LIMITS = {
  max_instructions: 100_000_000,
  max_memory_mb: 128,
  max_execution_seconds: 60,
};
const ENV_FILE = new URL("../.env", import.meta.url);
const OUTPUT = new URL("../deployments/testnet.json", import.meta.url);

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const url = process.env.CHECKER_WASM_URL;
if (!url) throw new Error("set CHECKER_WASM_URL to the URL `outlayer upload` printed");
const checkerWasm = loadWasm("target/wasm32-wasip2/release/provingground-checker.wasm");
const hash = sha256Hex(checkerWasm);
if (!url.includes(hash)) throw new Error(`that URL is not for this build, whose hash is ${hash}`);

const near = new Near({
  network: "testnet",
  keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), "testnet"),
  defaultWaitUntil: "FINAL",
});

// Unused fee comes back to the mandate's owner, and too little makes OutLayer refuse.
const estimate = await near.view(OUTLAYER, "estimate_execution_cost", {
  resource_limits: RESOURCE_LIMITS,
});
const fee = ((BigInt(String(estimate)) * 3n) / 2n).toString();
console.log(`OutLayer estimate: ${estimate} yocto. Fee per check: ${fee} yocto.`);

await deployVault(near, {
  vaultId: VAULT,
  wasm: loadWasm("target/near/provingground_vault/provingground_vault.wasm"),
  checker: {
    outlayer: OUTLAYER,
    source: { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } },
    secrets_ref: { profile: SECRETS_PROFILE, account_id: OWNER },
    fee,
    max_instructions: String(RESOURCE_LIMITS.max_instructions),
    max_memory_mb: RESOURCE_LIMITS.max_memory_mb,
    max_execution_seconds: String(RESOURCE_LIMITS.max_execution_seconds),
    check_timeout_ns: CHECK_TIMEOUT_NS,
  },
});
console.log(`Vault deployed to ${VAULT}`);

const env = readEnvFile();
if (!env.AGENT_PRIVATE_KEY) {
  const key = await addAgentKey(near, {
    agentId: AGENT,
    vaultId: VAULT,
    allowance: AGENT_ALLOWANCE,
  });
  appendFileSync(ENV_FILE, `AGENT_PRIVATE_KEY=${key.secretKey}\n`);
  console.log("Agent key added and saved to .env");
}
let checkerSecret = env.CHECKER_SECRET_KEY;
if (!checkerSecret) {
  checkerSecret = randomBytes(32).toString("hex");
  appendFileSync(ENV_FILE, `CHECKER_SECRET_KEY=${checkerSecret}\n`);
  console.log("Checker key generated and saved to .env");
}
const checkerPublicKey = createPublicKey(
  createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      Buffer.from(checkerSecret, "hex"),
    ]),
    format: "der",
    type: "pkcs8",
  }),
)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true });
writeFileSync(
  OUTPUT,
  `${JSON.stringify(
    {
      network: "testnet",
      vault: VAULT,
      owner: OWNER,
      agent: AGENT,
      vendor: VENDOR,
      attacker: ATTACKER,
      outlayer: OUTLAYER,
      checker_public_key: checkerPublicKey,
      checker_wasm_url: url,
      checker_wasm_sha256: hash,
      vault_wasm_sha256: sha256Hex(
        loadWasm("target/near/provingground_vault/provingground_vault.wasm"),
      ),
      secrets_profile: SECRETS_PROFILE,
      fee_yocto: fee,
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote ${OUTPUT.pathname}`);
