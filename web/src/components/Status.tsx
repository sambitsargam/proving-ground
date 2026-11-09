import { Icon, type IconName } from "./Icon.tsx";

export type Tone = "safe" | "parked" | "threat" | "idle";

const ICONS: Record<Tone, IconName> = {
  safe: "shield",
  parked: "pause",
  threat: "alert",
  idle: "minus",
};

/** A verdict label. Always a word and an icon, never color alone. */
export function Status({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className={`status status-${tone}`}>
      <Icon name={ICONS[tone]} size={14} />
      {children}
    </span>
  );
}
