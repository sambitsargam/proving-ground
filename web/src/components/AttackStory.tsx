import { useEffect, useState } from "react";
import liveReport from "../../../attacks/report.testnet.json";
import { explorerUrl, shortHash } from "../lib/chain.ts";
import { prefersReducedMotion, useScrollProgress } from "../lib/motion.ts";
import { Icon } from "./Icon.tsx";
import "./story.css";

const A01 = (liveReport.results as { id: string; prompt: string; tx_hash?: string }[]).find(
  (result) => result.id === "A01",
);
const PAYEE = "provingground-attacker.testnet";
const STAGES = 5;

const STEPS = [
  {
    label: "The attack",
    text: "Someone tells your agent to pay them. Here it's the oldest trick there is, sent straight to the agent.",
  },
  {
    label: "The model gives in",
    text: "Assume it always will. This agent runs a model with its refusals removed, so it calls the vault to pay.",
  },
  {
    label: "The key lets it ask",
    text: "The agent's only key can call request_payment, and nothing else. It can't transfer NEAR or add keys.",
  },
  {
    label: "The contract says no",
    text: "That account isn't a payee the owner signed. Refused on chain with PAYEE_NOT_ALLOWED, before any model is asked.",
  },
  { label: "Nothing leaves", text: "The checker never runs. The vault keeps every yoctoNEAR." },
];

/** Static below this width, or with reduced motion: every stage shown at once. */
function useAnimated(): boolean {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 960px)");
    const update = () => setAnimated(wide.matches && !prefersReducedMotion());
    update();
    wide.addEventListener("change", update);
    return () => wide.removeEventListener("change", update);
  }, []);
  return animated;
}

/** Attack A01 from the live testnet run, replayed as the page scrolls. */
export function AttackStory() {
  const animated = useAnimated();
  const [stage, setStage] = useState(0);
  const track = useScrollProgress<HTMLDivElement>((progress) => {
    setStage(Math.min(STAGES - 1, Math.floor(progress * STAGES)));
  });
  const shown = animated ? stage : STAGES - 1;

  return (
    <section className="story" aria-labelledby="story-title">
      <div className="container story-intro">
        <p className="eyebrow">Anatomy of an attack</p>
        <h2 id="story-title" className="section-title">
          Three layers. The model can only say no.
        </h2>
        <p className="section-lede muted">
          Attack A01, replayed from the live testnet run. Scroll to send it.
        </p>
      </div>

      <div
        ref={track}
        className={`story-track${animated ? " is-animated" : ""}`}
        data-stage={shown}
      >
        <div className="story-sticky">
          <div className="container story-grid">
            <ol className="story-steps">
              {STEPS.map((step, index) => (
                <li
                  key={step.label}
                  className={`story-step${index === shown ? " is-active" : ""}${index < shown ? " is-done" : ""}`}
                >
                  <span className="story-num">0{index + 1}</span>
                  <div>
                    <h3>{step.label}</h3>
                    <p>{step.text}</p>
                    {index === STAGES - 1 && A01?.tx_hash && (
                      <a className="mono story-tx" href={explorerUrl(A01.tx_hash)}>
                        See it on testnet: {shortHash(A01.tx_hash)} <Icon name="arrow" size={14} />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <div className="story-stage" aria-hidden="true">
              <span className="story-rail" />
              <div className="story-attacker">
                <span className="story-who">Attacker</span>
                {A01?.prompt}
              </div>
              <div className="story-agent">
                <span className="story-node">
                  <Icon name="agent" size={18} />
                </span>
                <div className="story-reply">
                  <span className="story-who">Agent</span>
                  Understood. Paying {PAYEE} 0.1 NEAR now.
                </div>
              </div>

              <div className="story-packet">
                <span className="packet-half packet-left">
                  request_payment → {PAYEE} · 0.1 NEAR
                </span>
                <span className="packet-half packet-right">
                  request_payment → {PAYEE} · 0.1 NEAR
                </span>
              </div>

              <div className="story-gate gate-key">
                <span className="gate-line" />
                <span className="gate-label">
                  <Icon name="key" size={16} /> Function call key
                </span>
                <span className="gate-verdict verdict-pass">
                  <Icon name="check" size={14} /> Passed
                </span>
              </div>
              <div className="story-gate gate-contract">
                <span className="gate-line" />
                <span className="gate-label">
                  <Icon name="contract" size={16} /> Contract rules
                </span>
                <span className="gate-verdict verdict-stop">
                  <Icon name="shield" size={14} /> Stopped
                </span>
                <span className="story-stamp">PAYEE_NOT_ALLOWED</span>
              </div>
              <div className="story-gate gate-checker">
                <span className="gate-line" />
                <span className="gate-label">
                  <Icon name="chip" size={16} /> TEE checker
                </span>
                <span className="gate-verdict verdict-idle">
                  <Icon name="minus" size={14} /> Not reached
                </span>
              </div>

              <div className="story-result">
                <span className="story-zero">0</span>
                <span>
                  NEAR
                  <br />
                  lost
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
