export type IconName = "check" | "shield" | "pause" | "alert" | "minus" | "arrow";

const PATHS: Record<IconName, string> = {
  check: "M4 10.5l4 4 8-9",
  shield: "M10 2.5l6.5 2.5v5c0 4-2.8 6.8-6.5 8-3.7-1.2-6.5-4-6.5-8V5L10 2.5zM7 10l2.2 2.2L13.5 8",
  pause: "M7.5 5v10M12.5 5v10",
  alert: "M10 3.5l7.5 13h-15L10 3.5zM10 8.5v3.5M10 14.5v.5",
  minus: "M5 10h10",
  arrow: "M4 10h12M11 5l5 5-5 5",
};

/** Inline, so icons inherit the text color and need no request. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
