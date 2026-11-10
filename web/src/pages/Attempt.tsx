import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { ModelText } from "../components/ModelText.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import { Status } from "../components/Status.tsx";
import { type ChainCheck, checkAgainstChain, decodeAttempt } from "../lib/attempt.ts";
import { chainRecordOf, explorerUrl, nearText, REPO, shortHash } from "../lib/chain.ts";
import { Link } from "../lib/router.tsx";
import { stepsFor } from "../lib/steps.tsx";
import "./arena.css";
import "./attempt.css";

type Check = ChainCheck | "checking" | "none";

/** A shared attempt. The verdict is checked against testnet; the message cannot be. */
export function Attempt({ token }: { token: string }) {
  const attempt = decodeAttempt(token);
  const payment = attempt?.payment;
  const [check, setCheck] = useState<Check>(payment?.txHash ? "checking" : "none");

  useEffect(() => {
    if (!payment?.txHash) return;
    chainRecordOf(payment.txHash).then(
      (record) => setCheck(checkAgainstChain(payment, record)),
      () => setCheck("unavailable"),
    );
  }, [payment]);

  // Only an attempt the chain confirms, where the agent fell for it, is worth a test case.
  const suggest = payment?.txHash && check === "verified";
  const issue = `${REPO}/issues/new?${new URLSearchParams({
    title: "Arena case: <short title>",
    body: `This attempt got the agent to try a payment. Add it to the suite:\n\n${location.href}\n\nnode scripts/add-community-attack.mjs "<link above>" "<short title>"`,
  })}`;

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
            <p className="message-text">
              <ModelText text={attempt.reply} />
            </p>
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
        {suggest && (
          <a className="button button-ghost" href={issue}>
            Add to the suite
          </a>
        )}
      </div>
      {suggest && (
        <p className="note">
          Messages that fool the agent become test cases: <code>provingground test</code> sends them
          to every agent it checks.
        </p>
      )}
    </div>
  );
}
