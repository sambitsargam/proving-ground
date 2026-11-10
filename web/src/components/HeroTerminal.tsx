import { useEffect, useState } from "react";
import mockReport from "../../../attacks/report.json";
import { prefersReducedMotion } from "../lib/motion.ts";
import { Icon } from "./Icon.tsx";
import "./terminal.css";

const COMMAND = "npx provingground-cli test";
const SHOWN = 4;

interface Row {
  id: string;
  layer: string;
  reason: string;
  decision: string;
}

const rows = (mockReport.results as Row[]).slice(0, SHOWN);
const hash = mockReport.vault_wasm_sha256;
const { attacks, stopped } = mockReport.summary;

/** The lines the CLI prints, in order, with the title column left out to fit. */
const OUTPUT: { text: string; tone?: "muted" | "safe"; tag?: "SAFE" | "PARK" }[] = [
  { text: "Mode: mock. Agent: fully compromised.", tone: "muted" },
  { text: `Vault contract sha256: ${hash.slice(0, 8)}…${hash.slice(-4)}`, tone: "muted" },
  ...rows.map((row) => ({
    text: `${row.id}  ${row.layer.padEnd(10)}${row.reason}`,
    // The CLI's own words: SAFE when refused, PARK when it waits for the owner.
    tag: row.decision === "PARK" ? ("PARK" as const) : ("SAFE" as const),
  })),
  { text: `… ${attacks - SHOWN} more`, tone: "muted" },
  { text: `${stopped} attacks stopped, 0 funds lost`, tone: "safe" },
];

/** A run of the real CLI, typed out once. Decoration: the label carries the result. */
export function HeroTerminal() {
  const [typed, setTyped] = useState(0);
  const [lines, setLines] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setTyped(COMMAND.length);
      setLines(OUTPUT.length);
      return;
    }
    setTyped(0);
    setLines(0);
    const timers: number[] = [];
    const start = run === 0 ? 1300 : 200;
    for (let i = 1; i <= COMMAND.length; i += 1) {
      timers.push(window.setTimeout(() => setTyped(i), start + i * 38));
    }
    const afterCommand = start + COMMAND.length * 38 + 350;
    for (let i = 1; i <= OUTPUT.length; i += 1) {
      timers.push(window.setTimeout(() => setLines(i), afterCommand + i * 140));
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [run]);

  const done = lines === OUTPUT.length;
  return (
    <div className="term hud">
      <div className="term-bar">
        <span className="term-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="term-title">~/your-agent</span>
        <button
          type="button"
          className="term-replay"
          onClick={() => setRun((n) => n + 1)}
          disabled={!done}
        >
          Run again
        </button>
      </div>
      <div
        className="term-body"
        role="img"
        aria-label={`Running ${COMMAND} prints one line per attack and ends with: ${stopped} attacks stopped, 0 funds lost.`}
      >
        <p className="term-line">
          <span className="term-prompt">$</span> {COMMAND.slice(0, typed)}
          {!done && <span className="term-caret" />}
        </p>
        {OUTPUT.slice(0, lines).map((line) => (
          <p key={line.text} className={`term-line${line.tone ? ` term-${line.tone}` : ""}`}>
            {line.tone === "safe" && <Icon name="shield" size={13} />}
            {line.text}
            {line.tag && (
              <span className={`term-tag ${line.tag === "PARK" ? "term-parked" : "term-safe"}`}>
                {line.tag}
              </span>
            )}
          </p>
        ))}
      </div>
    </div>
  );
}
