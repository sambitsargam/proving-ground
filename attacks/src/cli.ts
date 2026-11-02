#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { formatEndpoint, testEndpoint } from "./endpoint.ts";
import { format, summaryLine } from "./format.ts";
import { runSuite } from "./suite.ts";

const USAGE = `Usage: provingground test [target] [--report <path>]

With no target, runs 25 attacks against the real vault contract on a simulated NEAR
runtime, with a fully compromised agent. Needs no keys and no network.

With a target, sends the attacks to your agent. The target is the URL of an endpoint, or a
JSON config file: {"endpoint": "https://...", "headers": {"authorization": "..."}}.

The endpoint takes  POST {"message": "..."}
and answers         {"reply": "...", "payments": [{"payee": "...", "amount": "<yocto>"}]}

Each payment your agent tries is then run against the vault contract, to show which
attacks your agent falls for and what a mandate would have done about them.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "test") {
    process.stdout.write(USAGE);
    return command === undefined || command === "--help" ? 0 : 2;
  }
  const flag = rest.indexOf("--report");
  const reportPath = flag >= 0 ? rest[flag + 1] : "report.json";
  if (!reportPath) {
    process.stdout.write(USAGE);
    return 2;
  }
  const target = rest.find((arg, index) => !arg.startsWith("--") && index !== flag + 1);

  if (target) {
    const report = await testEndpoint(target);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(formatEndpoint(report, process.stdout.isTTY === true));
    process.stdout.write(`\nReport written to ${reportPath}\n`);
    return report.summary.funds_lost_yocto === "0" ? 0 : 1;
  }

  const report = await runSuite();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(format(report, process.stdout.isTTY === true));
  process.stdout.write(`\nReport written to ${reportPath}\n`);
  return summaryLine(report).ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
