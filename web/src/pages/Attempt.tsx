import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import { Status } from "../components/Status.tsx";
import { decodeAttempt } from "../lib/attempt.ts";
import { decisionsOf, explorerUrl, nearText, shortHash } from "../lib/chain.ts";
import { Link } from "../lib/router.tsx";
import { stepsFor } from "../lib/steps.tsx";
import "./arena.css";
import "./attempt.css";

type Check = "checking" | "verified" | "mismatch" | "unavailable" | "none";

/** A shared attempt. The verdict is checked against testnet; the message cannot be. */
export function Attempt({ token }: { token: string }) {
  const attempt = decodeAttempt(token);
  const payment = attempt?.payment;
  const [check, setCheck] = useState<Check>(payment?.txHash ? "checking" : "none");

  useEffect(() => {
    if (!payment?.txHash) return;
    decisionsOf(payment.txHash).then(
      (events) => {
        const last = events.at(-1);
        const matches =
          last?.decision !== undefined &&
          last.reason === payment.reason &&
          (last.payee === undefined || last.payee === payment.payee);
        setCheck(matches ? "verified" : events.length ? "mismatch" : "unavailable");
      },
      () => setCheck("unavailable"),
    );
  }, [payment]);

  if (!attempt) {
    return (
      <div className="container attempt">
        <h1 className="arena-title">This link is broken</h1>
        <p className="muted">
          It may have been cut off. <Link href="/arena">Try the arena yourself</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="container attempt">
      <p className="eyebrow">Shared attempt</p>
      <h1 className="arena-title">Someone tried to talk the agent into paying them</h1>

      <div className="attempt-grid">
        <section className="card" aria-labelledby="conversation-title">
          <h2 id="conversation-title" className="card-heading">
            The conversation
          </h2>
          <div className="message message-attacker">
            <p className="message-who">Attacker</p>
            <p>{attempt.message}</p>
          </div>
          <div className="message">
            <p className="message-who">Agent</p>
            <p className="message-text">{attempt.reply}</p>
            {payment && (
              <p className="message-tried">
                <Icon name="alert" size={14} />
                Tried: pay <code>{nearText(payment.amount)} NEAR</code> to{" "}
                <code>{payment.payee}</code>
              </p>
            )}
          </div>
          <p className="note">
            The conversation is as the person who shared it reported. It never goes on-chain.
          </p>
        </section>

        <section className="card" aria-labelledby="decision-title">
          <div className="panel-head">
            <h2 id="decision-title">Decision</h2>
            {check === "verified" && <Status tone="safe">Verified on testnet</Status>}
            {check === "mismatch" && <Status tone="threat">Does not match the chain</Status>}
            {check === "checking" && <Status tone="idle">Checking the chain</Status>}
            {check === "unavailable" && <Status tone="idle">Could not reach testnet</Status>}
          </div>
          <Pipeline title="What each layer decided" steps={stepsFor(payment)} />
          {payment?.txHash && (
            <a className="mono tx-link attempt-tx" href={explorerUrl(payment.txHash)}>
              Transaction {shortHash(payment.txHash)} <Icon name="arrow" size={14} />
            </a>
          )}
        </section>
      </div>

      <div className="button-row">
        <Link className="button button-primary" href="/arena">
          Try it yourself <Icon name="arrow" />
        </Link>
      </div>
    </div>
  );
}
