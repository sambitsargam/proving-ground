// The deployed arena: the demo agent, a real model with its refusals removed, paying through
// the guard SDK into the testnet vault. Configuration comes from the environment.

import { readFileSync } from "node:fs";
import { NearAiBrain, TreasuryAgent } from "provingground-demo-agent";
import { Guard, HttpBlobStore } from "provingground-guard";
import { NearVault } from "provingground-guard/near";
import { arenaServer } from "./arena.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface Deployment {
  vault: string;
  agent: string;
  checker_public_key: string;
  mandate: { id: string; payee: string; purpose: string; purpose_salt: string };
}

const deployment = JSON.parse(
  readFileSync(new URL("../../../deployments/testnet.json", import.meta.url), "utf8"),
) as Deployment;
const { mandate } = deployment;

const guard = new Guard({
  vault: new NearVault({
    network: "testnet",
    vaultId: deployment.vault,
    accountId: deployment.agent,
    privateKey: required("AGENT_PRIVATE_KEY") as `ed25519:${string}`,
  }),
  blobs: new HttpBlobStore(required("BLOB_BASE_URL")),
  checkerPublicKey: deployment.checker_public_key,
  mandates: { [mandate.id]: { purpose: mandate.purpose, purposeSalt: mandate.purpose_salt } },
});
const agent = new TreasuryAgent({
  brain: new NearAiBrain({ apiKey: required("NEAR_AI_API_KEY") }),
  guard,
  mandateId: mandate.id,
});

const onRender = process.env.RENDER === "true";
const port = Number(process.env.PORT ?? (onRender ? 10_000 : 8788));
arenaServer({
  handle: (message) => agent.handle(message),
  listedPayees: [mandate.payee],
  attemptsPerHour: Number(process.env.ATTEMPTS_PER_HOUR ?? 6),
  attemptsPerDay: Number(process.env.ATTEMPTS_PER_DAY ?? 300),
  behindProxy: onRender,
  ...(process.env.WEB_ORIGIN ? { allowedOrigin: process.env.WEB_ORIGIN } : {}),
}).listen(port, () => {
  process.stdout.write(`arena listening on ${port}, mandate ${mandate.id}\n`);
});
