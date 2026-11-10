// The deployed arena: the demo agent, a real model with its refusals removed, paying through
// the guard SDK into the testnet vault. Configuration comes from the environment.

import { readFileSync } from "node:fs";
import { blobStore } from "provingground-blobs";
import { NearAiBrain, TreasuryAgent } from "provingground-demo-agent";
import { Guard } from "provingground-guard";
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
const onRender = process.env.RENDER === "true";

// The invoice store runs in this process, so one always-on instance covers both. The agent
// writes to it directly: going out through the host's proxy and back in would count the
// arena's own uploads against the per-client upload limit.
const invoices = blobStore({ behindProxy: onRender });

const guard = new Guard({
  vault: new NearVault({
    network: "testnet",
    vaultId: deployment.vault,
    accountId: deployment.agent,
    privateKey: required("AGENT_PRIVATE_KEY") as `ed25519:${string}`,
  }),
  blobs: {
    put: async (id, blob) => {
      if (!invoices.put(id, Buffer.from(blob))) throw new Error("invoice store refused the blob");
    },
  },
  checkerPublicKey: deployment.checker_public_key,
  mandates: { [mandate.id]: { purpose: mandate.purpose, purposeSalt: mandate.purpose_salt } },
});
const agent = new TreasuryAgent({
  brain: new NearAiBrain({ apiKey: required("NEAR_AI_API_KEY") }),
  guard,
  mandateId: mandate.id,
});

const port = Number(process.env.PORT ?? (onRender ? 10_000 : 8788));
arenaServer({
  handle: (message) => agent.handle(message),
  listedPayees: [mandate.payee],
  attemptsPerHour: Number(process.env.ATTEMPTS_PER_HOUR ?? 6),
  attemptsPerDay: Number(process.env.ATTEMPTS_PER_DAY ?? 300),
  behindProxy: onRender,
  blobs: invoices.handler,
  ...(process.env.WEB_ORIGIN ? { allowedOrigin: process.env.WEB_ORIGIN } : {}),
}).listen(port, () => {
  process.stdout.write(`arena listening on ${port}, mandate ${mandate.id}\n`);
});
