// Live mode: the attacks against the deployed vault on testnet, signed with real keys, and
// answered by the real checker on OutLayer. Only ever runs on testnet.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near, type PrivateKey } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { HttpBlobStore, MemoryBlobStore } from "provingground-guard";
import { NearVault } from "provingground-guard/near";
import { ChainWorld } from "./chain.ts";
import { type AttackResult, type Report, runSuite } from "./suite.ts";

const DEFAULT_RPC = "https://test.rpc.fastnear.com";
/** Long enough for create_mandate to finish before the mandate ends. */
const EXPIRY_MS = 20_000;

interface Deployment {
  network: string;
  vault: string;
  owner: string;
  agent: string;
  vendor: string;
  attacker: string;
  checker_public_key: string;
  vault_wasm_sha256: string;
}

export async function runLive(
  deploymentPath: string,
  options: { only?: string[]; onResult?: (result: AttackResult) => void } = {},
): Promise<Report> {
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;
  if (deployment.network !== "testnet") throw new Error("live mode only runs on testnet");
  const agentKey = process.env.AGENT_PRIVATE_KEY as PrivateKey | undefined;
  if (!agentKey) throw new Error("AGENT_PRIVATE_KEY is not set");

  const rpcUrl = process.env.NEAR_RPC_URL ?? DEFAULT_RPC;
  const blobUrl = process.env.BLOB_BASE_URL;
  if (!blobUrl) {
    process.stderr.write(
      "BLOB_BASE_URL is not set. The checker cannot read invoices, so anything that reaches it parks.\n",
    );
  }

  const setup = {
    near: new Near({
      network: "testnet",
      rpcUrl,
      keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), "testnet"),
    }),
    agentNear: new Near({
      network: "testnet",
      rpcUrl,
      privateKey: agentKey,
      defaultSignerId: deployment.agent,
    }),
    rpcUrl,
    vault: deployment.vault,
    owner: deployment.owner,
    agent: deployment.agent,
    vendor: deployment.vendor,
    attacker: deployment.attacker,
    // Listed by one attack's second mandate and never paid, so it need not exist.
    payroll: `payroll.${deployment.owner}`,
    vaultClient: new NearVault({
      network: "testnet",
      rpcUrl,
      vaultId: deployment.vault,
      accountId: deployment.agent,
      privateKey: agentKey,
    }),
    blobs: blobUrl ? new HttpBlobStore(blobUrl) : new MemoryBlobStore(),
    checkerPublicKey: deployment.checker_public_key,
    runId: Date.now().toString(36),
    recover: true,
    expiryMs: EXPIRY_MS,
  };

  return runSuite({
    mode: "testnet",
    checkerControl: false,
    vaultSha256: deployment.vault_wasm_sha256,
    makeWorld: () => ChainWorld.create(setup),
    ...(options.only ? { only: options.only } : {}),
    ...(options.onResult ? { onResult: options.onResult } : {}),
  });
}
