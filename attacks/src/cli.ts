#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatEndpoint, testEndpoint } from "./endpoint.ts";
import { format, summaryLine } from "./format.ts";
import { type Report, runSuite } from "./suite.ts";

const USAGE = `Usage: provingground test [target] [--live <deployment.json>] [--only A01,A02] [--report <path>]

With no target, runs 25 attacks against the real vault contract on a simulated NEAR
runtime, with a fully compromised agent. Needs no keys and no network.

With a target, sends the attacks to your agent. The target is the URL of an endpoint, or a
JSON config file: {"endpoint": "https://...", "headers": {"authorization": "..."}}.

The endpoint takes  POST {"message": "..."}
and answers         {"reply": "...", "payments": [{"payee": "...", "amount": "<yocto>"}]}

Each payment your agent tries is then run against the vault contract, to show which
attacks your agent falls for and what a mandate would have done about them.

With --live, runs them against a vault deployed on testnet, with real transactions and the
real checker. Needs AGENT_PRIVATE_KEY, BLOB_BASE_URL and the owner's and attacker's keys in
~/.near-credentials. Spends a little testnet NEAR.
`;

function usage(code: number): number {
  process.stdout.write(USAGE);
  return code;
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch {
    return usage(2);
  }
  const { command, target, values } = parsed;
  if (values.help || command === undefined) return usage(0);
  if (command !== "test") return usage(2);
  const reportPath = values.report ?? "report.json";
  const only = values.only?.split(",");

  if (target) {
    const report = await testEndpoint(target);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(formatEndpoint(report, process.stdout.isTTY === true));
    process.stdout.write(`\nReport written to ${reportPath}\n`);
    return report.summary.funds_lost_yocto === "0" ? 0 : 1;
  }

  let report: Report;
  if (values.live) {
    // Loaded here so that mock mode never touches the chain client.
    const { runLive } = await import("./live.ts");
    report = await runLive(values.live, {
      ...(only ? { only } : {}),
      onResult: (r) => process.stderr.write(`${r.id} ${r.layer} ${r.decision} ${r.reason}\n`),
    });
  } else {
    report = await runSuite(only ? { only } : {});
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(format(report, process.stdout.isTTY === true));
  process.stdout.write(`\nReport written to ${reportPath}\n`);
  return summaryLine(report).ok ? 0 : 1;
}

function parseCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      report: { type: "string" },
      live: { type: "string" },
      only: { type: "string" },
    },
  });
  const [command, target] = positionals;
  return { command, target, values };
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
