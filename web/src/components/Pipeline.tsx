import type { CSSProperties, ReactNode } from "react";
import { Status, type Tone } from "./Status.tsx";
import "./pipeline.css";

export interface Step {
  layer: string;
  tone: Tone;
  label: string;
  detail?: ReactNode;
  /** The step that made the call. It gets the only glow. */
  decisive?: boolean;
}

/** Each layer's verdict, top to bottom, lighting up in order. */
export function Pipeline({ steps, title }: { steps: Step[]; title: string }) {
  return (
    <ol className="pipeline" aria-label={title}>
      {steps.map((step, index) => (
        <li
          key={step.layer}
          className={`pipeline-step tone-${step.tone}${step.decisive ? " decisive" : ""}`}
          style={{ "--step": index } as CSSProperties}
        >
          <span className="pipeline-node" aria-hidden="true" />
          <div className="pipeline-body">
            <div className="pipeline-head">
              <span className="pipeline-layer">{step.layer}</span>
              <Status tone={step.tone}>{step.label}</Status>
            </div>
            {step.detail && <div className="pipeline-detail">{step.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
