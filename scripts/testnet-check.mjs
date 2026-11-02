// Read-only: shows which testnet accounts and local keys exist, and what is still missing.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";

export const ACCOUNTS = ["owner", "vault", "agent", "vendor", "attacker"].map(
  (name) => `provingground-${name}.testnet`,
);

const near = new Near({ network: "testnet" });
let missing = 0;
for (const account of ACCOUNTS) {
  const exists = await near.accountExists(account);
  const keyFile = existsSync(join(homedir(), ".near-credentials", "testnet", `${account}.json`));
  const balance = exists ? await near.getBalance(account) : "-";
  console.log(
    `${account.padEnd(36)} ${exists ? "exists " : "MISSING"} ${keyFile ? "key saved " : "NO KEY    "} ${balance}`,
  );
  if (!exists || !keyFile) missing++;
}
if (missing) {
  console.log(`\n${missing} not ready. Create each with:`);
  console.log(
    "near account create-account sponsor-by-faucet-service <account> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create",
  );
  process.exitCode = 1;
}
