#!/usr/bin/env node
// Turns a shared arena attempt into a case in attacks/community.json, so every agent
// tested with `provingground test <endpoint>` gets the same message.
//
//   node scripts/add-community-attack.mjs "<attempt link>" "<short title>"
//
// The attempt has to carry a testnet transaction, and the chain has to agree with it.
import { readFileSync, writeFileSync } from "node:fs";

const RPC = "https://test.rpc.fastnear.com";
const FILE = new URL("../attacks/community.json", import.meta.url);

function decode(link) {
  const token = new URL(link).searchParams.get("t");
  if (!token) throw new Error("not an attempt link: it has no ?t=");
  const json = Buffer.from(token, "base64url").toString("utf8");
  const value = JSON.parse(json);
  if (value.v !== 1 || typeof value.m !== "string") throw new Error("unknown attempt format");
  return { message: value.m, payment: value.p };
}

async function chainDecision(txHash, sender) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "pg",
      method: "tx",
      params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" },
    }),
  });
  const body = await response.json();
  const value = body.result?.status?.SuccessValue;
  if (!value) throw new Error(`transaction ${txHash} has no result on testnet`);
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

async function main([link, title]) {
  if (!link || !title) {
    process.stderr.write(
      'Usage: node scripts/add-community-attack.mjs "<attempt link>" "<title>"\n',
    );
    return 2;
  }
  const { message, payment } = decode(link);
  if (!payment?.txHash) throw new Error("the attempt has no transaction to check");
  const deployment = JSON.parse(
    readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"),
  );
  const onChain = await chainDecision(payment.txHash, deployment.agent);
  if (onChain.decision !== payment.decision || onChain.reason !== payment.reason) {
    throw new Error(`the link says ${payment.decision}, the chain says ${onChain.decision}`);
  }

  const community = JSON.parse(readFileSync(FILE, "utf8"));
  if (community.cases.some((c) => c.prompt === message)) {
    process.stdout.write("Already in the suite.\n");
    return 0;
  }
  const id = `C${String(community.cases.length + 1).padStart(2, "0")}`;
  community.cases.push({
    id,
    title,
    prompt: message,
    arena: { decision: onChain.decision, reason: onChain.reason, tx: payment.txHash },
  });
  writeFileSync(FILE, `${JSON.stringify(community, null, 2)}\n`);
  process.stdout.write(`Added ${id}: ${title}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
