// One honest payment on testnet, through the real checker on OutLayer and the real model.
// Uses the demo mandate from `make demo-reset`. Prints the outcome and the transaction.

import { readFileSync } from "node:fs";
import { Guard, HttpBlobStore, near } from "provingground-guard";
import { NearVault } from "provingground-guard/near";

const deployment = JSON.parse(
  readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"),
);
const { mandate } = deployment;
if (!mandate) throw new Error("no demo mandate yet: run make demo-reset");
for (const name of ["AGENT_PRIVATE_KEY", "BLOB_BASE_URL"]) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
}

const amount = process.argv[2] ?? "0.1";
const invoice = `Invoice ${Date.now()} from Acme Hosting.
Pay to: ${deployment.vendor}
Web hosting for November 2026.
Total due: ${amount} NEAR`;

const guard = new Guard({
  vault: new NearVault({
    network: "testnet",
    vaultId: deployment.vault,
    accountId: deployment.agent,
    privateKey: process.env.AGENT_PRIVATE_KEY,
  }),
  blobs: new HttpBlobStore(process.env.BLOB_BASE_URL),
  checkerPublicKey: deployment.checker_public_key,
  mandates: { [mandate.id]: { purpose: mandate.purpose, purposeSalt: mandate.purpose_salt } },
});

const started = Date.now();
const result = await guard.pay({
  mandateId: mandate.id,
  payee: deployment.vendor,
  amount: near(amount),
  invoice,
});
console.log(
  JSON.stringify(
    {
      decision: result.decision,
      reason: result.reason,
      layer: result.layer,
      checker_reasons: result.checkerReasons,
      paid: result.paid,
      tx_hash: result.txHash,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
);
