import { useEffect, useState } from "react";
import mockReport from "../../../attacks/report.json";
import liveReport from "../../../attacks/report.testnet.json";
import { Hero3D } from "../components/Hero3D.tsx";
import { Icon } from "../components/Icon.tsx";
import { Status } from "../components/Status.tsx";
import { stats as fetchStats, type Stats, wake } from "../lib/arena.ts";
import { explorerUrl, nearText, REPO, shortHash, VAULT } from "../lib/chain.ts";
import { Link } from "../lib/router.tsx";
import "./landing.css";

interface ReportResult {
  id: string;
  title: string;
  layer: string;
  decision: string;
  reason: string;
  checker_reasons: string[];
  stopped: boolean;
  tx_hash?: string;
}

const suite = mockReport.results as ReportResult[];
const live = new Map((liveReport.results as ReportResult[]).map((r) => [r.id, r]));
const liveStopped = (liveReport.results as ReportResult[]).filter((r) => r.stopped).length;

const SNIPPET = `import { Guard, near } from "provingground-guard";
import { NearVault } from "provingground-guard/near";

const guard = new Guard({ vault: new NearVault(config), blobs, checkerPublicKey, mandates });
const result = await guard.pay({ mandateId, payee, amount: near("12"), invoice });
// result.paid, result.parked, result.reason, result.layer`;

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{command}</code>
      <button
        type="button"
        className="button button-ghost button-small"
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => {},
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Landing() {
  const [arena, setArena] = useState<Stats | null>(null);
  useEffect(() => {
    wake();
    fetchStats().then(setArena);
  }, []);

  const recent = arena?.recent.length
    ? arena.recent.slice(0, 8).map((entry) => ({
        key: `${entry.at}-${entry.txHash ?? entry.reason}`,
        label: entry.payee,
        decision: entry.decision,
        reason: entry.reason,
        tx: entry.txHash,
      }))
    : (liveReport.results as ReportResult[]).slice(0, 8).map((result) => ({
        key: result.id,
        label: result.id,
        decision: result.decision,
        reason: result.reason,
        tx: result.tx_hash,
      }));

  return (
    <>
      <section className="container hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Payment mandates for AI agents, on NEAR</p>
          <h1 id="hero-title">
            Jailbreak the model all you want.{" "}
            <span className="hero-quiet">The money still can't leave.</span>
          </h1>
          <p className="hero-lede">
            Your agent's payments are bound to what you signed, and a contract enforces it. A model
            in a secure enclave checks each invoice too, but it can only ever refuse.
          </p>
          <div className="button-row">
            <Link className="button button-primary" href="/arena">
              Attack it <Icon name="arrow" />
            </Link>
            <a className="button button-ghost" href="#suite">
              Run the suite
            </a>
          </div>
        </div>
        <Hero3D />
      </section>

      <section className="container section" aria-labelledby="layers-title">
        <h2 id="layers-title" className="section-title">
          Three layers. The model can only say no.
        </h2>
        <ol className="layers">
          <li className="card layer">
            <p className="eyebrow">01 · Mandate</p>
            <h3>You sign the limits</h3>
            <p className="muted">
              Payees, amounts, a daily cap, an expiry and what the money is for, set from your own
              wallet. The agent's only key can ask for a payment, nothing else.
            </p>
          </li>
          <li className="card layer">
            <p className="eyebrow">02 · Contract rules</p>
            <h3>The contract checks every request</h3>
            <p className="muted">
              Wrong payee, over a limit, a replayed invoice, an expired mandate: refused with a
              reason, before any model is involved.
            </p>
          </li>
          <li className="card layer">
            <p className="eyebrow">03 · TEE checker</p>
            <h3>A model reads the invoice</h3>
            <p className="muted">
              Running in a secure enclave, it can stop a payment or send it to you. It cannot
              approve anything the contract refused.
            </p>
          </li>
        </ol>
      </section>

      <section className="container section" aria-labelledby="numbers-title">
        <h2 id="numbers-title" className="section-title">
          {arena ? "The arena so far" : "The numbers"}
        </h2>
        {arena ? (
          <dl className="counters">
            <div className="card counter">
              <dt>Attacks attempted</dt>
              <dd>{arena.attempts.toLocaleString()}</dd>
            </div>
            <div className="card counter">
              <dt>Payments stopped by the vault</dt>
              <dd>{arena.stopped.toLocaleString()}</dd>
            </div>
            <div className="card counter counter-safe">
              <dt>Funds lost</dt>
              <dd>
                {nearText(arena.lostYocto)} <span className="counter-unit">NEAR</span>
              </dd>
            </div>
          </dl>
        ) : (
          <dl className="counters">
            <div className="card counter">
              <dt>Scripted attacks</dt>
              <dd>{mockReport.summary.attacks}</dd>
            </div>
            <div className="card counter">
              <dt>Stopped live on testnet</dt>
              <dd>
                {liveStopped}
                <span className="counter-unit"> of {liveReport.results.length}</span>
              </dd>
            </div>
            <div className="card counter counter-safe">
              <dt>Funds lost</dt>
              <dd>
                0 <span className="counter-unit">NEAR</span>
              </dd>
            </div>
          </dl>
        )}
        <p className="note">
          {arena
            ? `Since ${new Date(arena.since).toLocaleString()}, when the arena last restarted.`
            : "From the scripted suite and the live testnet run. Arena counters appear while it is online."}
        </p>
      </section>

      <section className="container section" aria-labelledby="log-title">
        <h2 id="log-title" className="section-title">
          {arena?.recent.length ? "Live attack log" : "From the live testnet run"}
        </h2>
        <div className="card log" role="log" aria-label="Recent attacks">
          {recent.map((line) => (
            <p key={line.key} className="log-line">
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
        </div>
      </section>

      <section className="container section" id="suite" aria-labelledby="suite-title">
        <h2 id="suite-title" className="section-title">
          25 attacks. A fully compromised agent. Nothing leaves.
        </h2>
        <p className="section-lede muted">
          The suite plays an agent that always does what the attacker says, against the real
          contract. It needs no keys and no network.
        </p>
        <CopyCommand command="npx provingground test" />
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">
              Every attack in the suite and what stopped it
            </caption>
            <thead>
              <tr>
                <th scope="col">Attack</th>
                <th scope="col">Stopped by</th>
                <th scope="col">Reason</th>
                <th scope="col">On testnet</th>
              </tr>
            </thead>
            <tbody>
              {suite.map((result) => {
                const onChain = live.get(result.id);
                return (
                  <tr key={result.id}>
                    <td>
                      <span className="mono muted">{result.id}</span> {result.title}
                    </td>
                    <td>{result.layer}</td>
                    <td className="mono">{result.reason}</td>
                    <td>
                      {onChain?.tx_hash ? (
                        <a className="mono" href={explorerUrl(onChain.tx_hash)}>
                          {shortHash(onChain.tx_hash)}
                        </a>
                      ) : onChain ? (
                        <Status tone="safe">Refused</Status>
                      ) : (
                        <span className="muted">Mock only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          "Mock only" attacks need control of the checker, which real OutLayer does not allow. Key
          refusals happen before a transaction exists, so they have no hash.{" "}
          <a href={`${REPO}/blob/master/docs/THREAT_MODEL.md`}>What it does not stop</a>.
        </p>
      </section>

      <section className="container section" aria-labelledby="use-title">
        <h2 id="use-title" className="section-title">
          Put your own agent behind it
        </h2>
        <div className="two-up">
          <div className="card">
            <h3 className="card-title">Pay through the guard</h3>
            <pre className="code">
              <code>{SNIPPET}</code>
            </pre>
          </div>
          <div className="card">
            <h3 className="card-title">Test your agent</h3>
            <p className="muted">
              Point the suite at your agent's endpoint. It sends every attack, then runs whatever
              your agent tried against the contract.
            </p>
            <CopyCommand command="npx provingground test https://your-agent/chat" />
            <p className="muted">
              The vault is <a href={`https://testnet.nearblocks.io/address/${VAULT}`}>{VAULT}</a>.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
