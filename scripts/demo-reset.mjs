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
// Small enough for faucet accounts. The text and salt are public here: this is a demo mandate.
const PURPOSE = "Monthly web hosting from Acme Hosting, up to 0.25 NEAR a month.";

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
  payees: [deployment.vendor],
  purposeHash: hashPurpose(PURPOSE, purposeSalt),
  dailyCap: toYocto("0.5"),
  maxTotal: toYocto("1"),
  maxPerPayment: toYocto("0.25"),
  funding: toYocto("1"),
  checkerBudget: toYocto("0.2"),
  expiresAt: (now + 30n * DAY_NS).toString(),
  deposit: "1 NEAR",
});

deployment.mandate = {
  id: mandateId,
  payee: deployment.vendor,
  purpose: PURPOSE,
  purpose_salt: purposeSalt,
};
writeFileSync(DEPLOYMENT, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Mandate ${mandateId} is ready for ${deployment.agent}`);
