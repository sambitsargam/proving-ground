import type { Report } from "./suite.ts";

const YOCTO = 10n ** 24n;
// The product's fixed meanings: lime is money safe, amber is parked, red is the attacker.
const LIME = "\x1b[38;2;198;255;26m";
const AMBER = "\x1b[38;2;255;176;32m";
const THREAT = "\x1b[38;2;255;61;110m";
const MUTED = "\x1b[38;2;138;147;166m";
const RESET = "\x1b[0m";

export function nearText(yocto: string | bigint): string {
  const value = BigInt(yocto);
  const whole = value / YOCTO;
  const fraction = (value % YOCTO).toString().padStart(24, "0").replace(/0+$/, "").slice(0, 4);
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function summaryLine(report: Report): { text: string; ok: boolean } {
  const { attacks, stopped, skipped, funds_lost_yocto: lost } = report.summary;
  const ok = attacks === stopped && BigInt(lost) === 0n;
  const main = ok
    ? `${attacks} attacks stopped, 0 funds lost`
    : `${stopped} of ${attacks} attacks stopped as expected, ${nearText(lost)} NEAR lost`;
  const text = skipped ? `${main} (${skipped} need control of the checker, so did not run)` : main;
  return { text, ok };
}

function pad(text: string, width: number): string {
  const short = text.length > width ? `${text.slice(0, width - 3)}...` : text;
  return short.padEnd(width);
}

export function format(report: Report, color: boolean): string {
  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [];
  lines.push(paint(MUTED, `Mode: ${report.mode}. Agent: ${report.agent}.`));
  lines.push(paint(MUTED, `Vault contract sha256: ${report.vault_wasm_sha256}`));
  lines.push("");
  lines.push(
    paint(
      MUTED,
      `${pad("", 4)}${pad("Attack", 56)}${pad("Stopped by", 11)}${pad("Reason", 36)}Lost`,
    ),
  );
  for (const result of report.results) {
    const reason =
      result.reason +
      (result.layer === "checker" && result.checker_reasons.length
        ? ` (${result.checker_reasons.join(", ")})`
        : "");
    const parked = result.decision === "PARK";
    const good = result.stopped && result.as_expected;
    const mark = !good ? "FAIL" : parked ? "PARK" : "SAFE";
    const code = !good ? THREAT : parked ? AMBER : LIME;
    lines.push(
      `${paint(code, pad(result.id, 4))}${pad(result.title, 56)}${pad(result.layer, 11)}${pad(reason, 36)}${paint(code, `${nearText(result.funds_lost_yocto)} ${mark}`)}`,
    );
  }
  lines.push("");
  lines.push(
    paint(MUTED, "SAFE: refused. PARK: no money moved, waiting for the owner, who can reject it."),
  );
  lines.push("");
  lines.push("Known limits, not counted above:");
  for (const limit of report.known_limits) {
    lines.push(
      `${paint(AMBER, limit.id)}  ${limit.title}: ${nearText(limit.paid_to_listed_yocto)} NEAR to the listed payee, ${nearText(limit.funds_lost_yocto)} to anyone else.`,
    );
    lines.push(paint(MUTED, `    ${limit.explanation}`));
  }
  lines.push("");
  lines.push(
    paint(
      MUTED,
      `Checker fees burned across the suite: ${nearText(report.summary.fees_burned_yocto)} NEAR, from the owner's checker budget.`,
    ),
  );
  lines.push("");
  const summary = summaryLine(report);
  lines.push(paint(summary.ok ? LIME : THREAT, summary.text));
  return `${lines.join("\n")}\n`;
}
