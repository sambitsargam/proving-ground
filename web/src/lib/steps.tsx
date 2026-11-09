import type { Step } from "../components/Pipeline.tsx";
import type { Payment } from "./arena.ts";
import { nearText, VENDOR } from "./chain.ts";

/** Each layer's verdict for one payment the agent tried. */
export function stepsFor(payment: Payment | undefined): Step[] {
  if (!payment) {
    return [
      {
        layer: "Agent",
        tone: "safe",
        label: "Refused",
        decisive: true,
        detail: "The model did not try to pay anyone this time.",
      },
      { layer: "Function call key", tone: "idle", label: "Not reached" },
      { layer: "Contract rules", tone: "idle", label: "Not reached" },
      { layer: "TEE checker", tone: "idle", label: "Not reached" },
    ];
  }
  const { layer, decision, reason, checkerReasons } = payment;
  const toAttacker = payment.payee !== VENDOR;
  const paid = decision === "PAID";
  const parked = decision === "PARK";
  const stoppedAt = paid || parked ? null : layer;
  const code = (
    <>
      <code>{reason}</code>
      {checkerReasons.length > 0 && <> · {checkerReasons.join(", ")}</>}
    </>
  );

  const steps: Step[] = [
    {
      layer: "Jailbroken agent tried",
      tone: toAttacker ? "threat" : "idle",
      label: toAttacker ? "Attack" : "Listed vendor",
      detail: (
        <>
          Pay <code>{nearText(payment.amount)} NEAR</code> to{" "}
          <code>{payment.payee || "(blank)"}</code>
        </>
      ),
    },
    stoppedAt === "key"
      ? { layer: "Function call key", tone: "safe", label: "Stopped", decisive: true, detail: code }
      : { layer: "Function call key", tone: "safe", label: "Passed" },
  ];
  if (stoppedAt === "key") {
    steps.push({ layer: "Contract rules", tone: "idle", label: "Not reached" });
    steps.push({ layer: "TEE checker", tone: "idle", label: "Not reached" });
    return steps;
  }
  if (stoppedAt === "contract") {
    steps.push({
      layer: "Contract rules",
      tone: "safe",
      label: "Stopped",
      decisive: true,
      detail: code,
    });
    steps.push({ layer: "TEE checker", tone: "idle", label: "Not reached" });
    return steps;
  }
  steps.push({
    layer: "Contract rules",
    tone: "safe",
    label: "Passed",
    detail: "Listed payee, within limits",
  });
  if (parked) {
    steps.push({
      layer: "TEE checker",
      tone: "parked",
      label: "Parked",
      decisive: true,
      detail: code,
    });
  } else if (paid) {
    steps.push({
      layer: "TEE checker",
      tone: "safe",
      label: "Allowed",
      decisive: true,
      detail: <>Paid within the mandate, to the listed vendor</>,
    });
  } else {
    steps.push({
      layer: "TEE checker",
      tone: "safe",
      label: "Stopped",
      decisive: true,
      detail: code,
    });
  }
  return steps;
}
