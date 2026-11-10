import { type CSSProperties, type KeyboardEvent, useEffect, useState } from "react";
import mockReport from "../../../attacks/report.json";
import liveReport from "../../../attacks/report.testnet.json";
import { AttackStory } from "../components/AttackStory.tsx";
import { Hero3D } from "../components/Hero3D.tsx";
import { Icon } from "../components/Icon.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { type ReportResult, SuiteTable } from "../components/SuiteTable.tsx";
import { useCopy } from "../components/Toast.tsx";
import { VaultMark } from "../components/VaultMark.tsx";
import { stats as fetchStats, type Stats, wake } from "../lib/arena.ts";
import { explorerUrl, nearText, REPO, shortHash, VAULT } from "../lib/chain.ts";
import { useCountUp, useInView, useMagnetic } from "../lib/motion.ts";
import { Link } from "../lib/router.tsx";
import "./landing.css";

const suite = mockReport.results as ReportResult[];
const liveResults = liveReport.results as ReportResult[];
const live = new Map(liveResults.map((r) => [r.id, r]));
const liveStopped = liveResults.filter((r) => r.stopped).length;

const SNIPPET = `import { Guard, near } from "provingground-guard";
import { NearVault } from "provingground-guard/near";

const guard = new Guard({ vault: new NearVault(config), blobs, checkerPublicKey, mandates });
const result = await guard.pay({ mandateId, payee, amount: near("12"), invoice });
// result.paid, result.parked, result.reason, result.layer`;

/** Splits a line into words that rise in one after another. Each word appears once per line. */
function Words({ text, from = 0 }: { text: string; from?: number }) {
  return (
    <>
      {text.split(" ").map((word, index) => (
        <span key={word} className="word" style={{ "--i": from + index } as CSSProperties}>
          {word}{" "}
        </span>
      ))}
    </>
  );
}

function CopyCommand({ command }: { command: string }) {
  const copy = useCopy();
  return (
    <div className="command">
      <span className="command-prompt" aria-hidden="true">
        $
      </span>
      <code>{command}</code>
      <button
        type="button"
        className="button button-ghost button-small"
        onClick={() => copy(command, "Command copied")}
      >
        <Icon name="copy" size={14} /> Copy
      </button>
    </div>
  );
}

/** The attacks from the suite drift past, each with what refused it. Decoration only. */
function Ticker() {
  const items = suite.map((result) => (
    <span key={result.id} className="ticker-item">
      <span className="ticker-attack">
        <span className="mono">{result.id}</span> {result.title}
      </span>
      <span className="ticker-verdict">
        <Icon name="shield" size={13} /> {result.reason}
      </span>
    </span>
  ));
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">
        {items}
        {items}
      </div>
    </div>
  );
}

function Counter({
  label,
  value,
  text,
  unit,
  safe = false,
  note,
}: {
  label: string;
  value: number;
  /** Shown as is instead of counting, for amounts that are not whole numbers. */
  text?: string;
  unit?: string;
  safe?: boolean;
  note?: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const shown = useCountUp(value, seen);
  return (
    <div ref={ref} className={`card counter${safe ? " counter-safe" : ""}`}>
      <dt>{label}</dt>
      <dd>
        <span className="counter-value">{text ?? shown.toLocaleString()}</span>
        {unit && <span className="counter-unit">{unit}</span>}
      </dd>
      {note && <dd className="counter-note">{note}</dd>}
    </div>
  );
}

function UseIt() {
  const [tab, setTab] = useState<"sdk" | "cli">("sdk");
  const copy = useCopy();
  // Arrow keys move between tabs, as screen reader users expect.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = tab === "sdk" ? "cli" : "sdk";
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <div className="card use-card">
      <div className="tabs" role="tablist" aria-label="Ways to use it" onKeyDown={onKeyDown}>
        <button
          type="button"
          role="tab"
          id="tab-sdk"
          aria-controls="panel-sdk"
          aria-selected={tab === "sdk"}
          tabIndex={tab === "sdk" ? 0 : -1}
          className="chip"
          onClick={() => setTab("sdk")}
        >
          <Icon name="contract" size={14} /> Pay through the guard
        </button>
        <button
          type="button"
          role="tab"
          id="tab-cli"
          aria-controls="panel-cli"
          aria-selected={tab === "cli"}
          tabIndex={tab === "cli" ? 0 : -1}
          className="chip"
          onClick={() => setTab("cli")}
        >
          <Icon name="terminal" size={14} /> Test your agent
        </button>
      </div>
      {tab === "sdk" ? (
        <div role="tabpanel" id="panel-sdk" aria-labelledby="tab-sdk" className="tab-panel">
          <div className="code-wrap">
            <pre className="code">
              <code>{SNIPPET}</code>
            </pre>
            <button
              type="button"
              className="button button-ghost button-small code-copy"
              onClick={() => copy(SNIPPET, "Snippet copied")}
            >
              <Icon name="copy" size={14} /> Copy
            </button>
          </div>
          <CopyCommand command="npm install provingground-guard" />
        </div>
      ) : (
        <div role="tabpanel" id="panel-cli" aria-labelledby="tab-cli" className="tab-panel">
          <p className="muted">
            Point the suite at your agent's endpoint. It sends every attack, then runs whatever your
            agent tried against the real contract, and tells you which payments a mandate would have
            refused.
          </p>
          <CopyCommand command="npx provingground-cli test https://your-agent/chat" />
          <p className="muted">
            The vault is{" "}
            <a href={`https://testnet.nearblocks.io/address/${VAULT}`} className="mono">
              {VAULT}
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}

export function Landing() {
  const [arena, setArena] = useState<Stats | null>(null);
  const primary = useMagnetic<HTMLAnchorElement>();
  const closing = useMagnetic<HTMLAnchorElement>();
  useEffect(() => {
    wake();
    fetchStats().then(setArena);
  }, []);

  const hasLive = Boolean(arena?.recent.length);
  const recent = arena?.recent.length
    ? arena.recent.slice(0, 8).map((entry) => ({
        key: `${entry.at}-${entry.txHash ?? entry.reason}`,
        label: entry.payee,
        decision: entry.decision,
        reason: entry.reason,
        tx: entry.txHash,
      }))
    : liveResults.slice(0, 8).map((result) => ({
        key: result.id,
        label: result.id,
        decision: result.decision,
        reason: result.reason,
        tx: result.tx_hash,
      }));

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-floor" aria-hidden="true" />
        <div className="container hero-inner">
          <div className="hero-copy">
            <a className="hero-badge" href="#suite">
              <span className="live-dot" aria-hidden="true" />
              Live on NEAR testnet
              <span className="hero-badge-sep" aria-hidden="true" />
              <span className="mono">25 attacks · 0 NEAR lost</span>
            </a>
            <h1 id="hero-title">
              <Words text="Jailbreak the model all you want." />
              <span className="hero-quiet">
                <Words text="The money still" from={6} />
                <span className="hero-lock">
                  <Words text="can't leave." from={9} />
                </span>
              </span>
            </h1>
            <p className="hero-lede">
              Your agent's payments are bound to what you signed, and a contract enforces it. A
              model in a secure enclave checks each invoice too, but it can only ever refuse.
            </p>
            <div className="button-row">
              <Link ref={primary} className="button button-primary" href="/arena">
                Attack it <Icon name="arrow" />
              </Link>
              <a className="button button-ghost" href="#suite">
                Run the suite
              </a>
            </div>
          </div>
          <div className="hero-visual">
            <div className="hero-halo" aria-hidden="true" />
            <Hero3D />
          </div>
        </div>
        <Ticker />
      </section>

      <AttackStory />

      <section className="container section" aria-labelledby="numbers-title">
        <Reveal>
          <p className="eyebrow">{arena ? "Live arena" : "Proof"}</p>
          <h2 id="numbers-title" className="section-title">
            {arena ? "The arena so far" : "The numbers"}
          </h2>
        </Reveal>
        <Reveal delay={80}>
          {arena ? (
            <dl className="counters">
              <Counter label="Attacks attempted" value={arena.attempts} />
              <Counter label="Payments stopped by the vault" value={arena.stopped} />
              <Counter
                label="Funds lost"
                value={0}
                text={nearText(arena.lostYocto)}
                unit="NEAR"
                safe
                note="Anything paid outside the mandate would show here."
              />
            </dl>
          ) : (
            <dl className="counters">
              <Counter label="Scripted attacks" value={mockReport.summary.attacks} />
              <Counter
                label="Stopped live on testnet"
                value={liveStopped}
                unit={`of ${liveResults.length}`}
              />
              <Counter
                label="Funds lost"
                value={0}
                unit="NEAR"
                safe
                note="Real transactions, real model, real vault."
              />
            </dl>
          )}
          <p className="note">
            {arena
              ? `Since ${new Date(arena.since).toLocaleString()}, when the arena last restarted.`
              : "From the scripted suite and the live testnet run. Arena counters appear while it is online."}
          </p>
        </Reveal>
      </section>

      <section className="container section" aria-labelledby="log-title">
        <Reveal>
          <h2 id="log-title" className="section-title">
            {hasLive ? "Live attack log" : "From the live testnet run"}
          </h2>
        </Reveal>
        <Reveal delay={80}>
          <div className="terminal">
            <div className="terminal-bar">
              <span className="terminal-title mono">
                {hasLive && <span className="live-dot" aria-hidden="true" />}
                attack.log
              </span>
              <span className="mono muted">{VAULT}</span>
            </div>
            <div className="log" role="log" aria-label="Recent attacks">
              {recent.map((line, index) => (
                <p key={line.key} className="log-line" style={{ "--line": index } as CSSProperties}>
                  <span className="log-id">{line.label}</span>
                  <span
                    className={
                      line.decision === "PARK"
                        ? "log-parked"
                        : line.decision === "PAID"
                          ? "log-paid"
                          : "log-safe"
                    }
                  >
                    {line.decision}
                  </span>
                  <span>{line.reason}</span>
                  {line.tx ? (
                    <a className="log-tx" href={explorerUrl(line.tx)}>
                      {shortHash(line.tx)}
                    </a>
                  ) : (
                    <span className="log-tx">no tx</span>
                  )}
                </p>
              ))}
              <p className="log-line log-cursor" aria-hidden="true">
                <span className="cursor" />
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="container section" id="suite" aria-labelledby="suite-title">
        <Reveal>
          <p className="eyebrow">The suite</p>
          <h2 id="suite-title" className="section-title">
            25 attacks. A fully compromised agent. Nothing leaves.
          </h2>
          <p className="section-lede muted">
            The suite plays an agent that always does what the attacker says, against the real
            contract. It needs no keys and no network.
          </p>
          <CopyCommand command="npx provingground-cli test" />
        </Reveal>
        <Reveal delay={80}>
          <SuiteTable suite={suite} live={live} />
          <p className="note">
            "Mock only" attacks need control of the checker, which real OutLayer does not allow. Key
            refusals happen before a transaction exists, so they have no hash.{" "}
            <a href={`${REPO}/blob/master/docs/THREAT_MODEL.md`}>What it does not stop</a>.
          </p>
        </Reveal>
      </section>

      <section className="container section" aria-labelledby="use-title">
        <Reveal>
          <p className="eyebrow">Use it</p>
          <h2 id="use-title" className="section-title">
            Put your own agent behind it
          </h2>
        </Reveal>
        <Reveal delay={80}>
          <UseIt />
        </Reveal>
      </section>

      <section className="container closing" aria-labelledby="closing-title">
        <Reveal className="closing-inner">
          <VaultMark size={56} />
          <h2 id="closing-title">Your turn. Make it pay you.</h2>
          <p className="muted">
            A real model with its refusals removed, a real vault on testnet, one listed vendor.
          </p>
          <Link ref={closing} className="button button-primary" href="/arena">
            Attack it <Icon name="arrow" />
          </Link>
        </Reveal>
      </section>
    </>
  );
}
