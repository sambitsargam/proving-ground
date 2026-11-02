// Re-seeds the testnet demo: a fresh mandate for the agent, with the same terms every time.
// Earlier mandates stay on-chain and can be withdrawn from by the owner.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { hashPurpose, newPurposeSalt, near as toYocto } from "provingground-guard";
import { createMandate, DAY_NS } from "./lib/vault.mjs";

const DEPLOYMENT = new URL("../deployments/testnet.json", import.meta.url);
const VENDOR = "provingground-vendor.testnet";
const PURPOSE = "Monthly web hosting from Acme Hosting, up to 1 NEAR a month.";

const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
const near = new Near({
  network: "testnet",
  keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), "testnet"),
  defaultWaitUntil: "FINAL",
});

const purposeSalt = newPurposeSalt();
const now = BigInt(Date.now()) * 1_000_000n;
const mandateId = await createMandate(near, {
  vaultId: deployment.vault,
  ownerId: deployment.owner,
  agentId: deployment.agent,
  payees: [VENDOR],
  purposeHash: hashPurpose(PURPOSE, purposeSalt),
  dailyCap: toYocto("2"),
  maxTotal: toYocto("3"),
  maxPerPayment: toYocto("1"),
  funding: toYocto("3"),
  checkerBudget: toYocto("1"),
  expiresAt: (now + 30n * DAY_NS).toString(),
  deposit: "2 NEAR",
});

deployment.mandate = { id: mandateId, payee: VENDOR, purpose: PURPOSE, purpose_salt: purposeSalt };
writeFileSync(DEPLOYMENT, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Mandate ${mandateId} is ready for ${deployment.agent}`);
