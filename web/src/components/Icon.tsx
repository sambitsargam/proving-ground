export type IconName =
  | "check"
  | "shield"
  | "pause"
  | "alert"
  | "minus"
  | "arrow"
  | "key"
  | "contract"
  | "chip"
  | "agent"
  | "search"
  | "copy"
  | "terminal"
  | "close"
  | "share";

const PATHS: Record<IconName, string> = {
  check: "M4 10.5l4 4 8-9",
  shield: "M10 2.5l6.5 2.5v5c0 4-2.8 6.8-6.5 8-3.7-1.2-6.5-4-6.5-8V5L10 2.5zM7 10l2.2 2.2L13.5 8",
  pause: "M7.5 5v10M12.5 5v10",
  alert: "M10 3.5l7.5 13h-15L10 3.5zM10 8.5v3.5M10 14.5v.5",
  minus: "M5 10h10",
  arrow: "M4 10h12M11 5l5 5-5 5",
  key: "M8 12.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM11 9h6.5M15 9v3M17.5 9v2",
  contract: "M5.5 2.5h6l3.5 3.5v11.5h-9.5V2.5zM11.5 2.5V6H15M8 10h4.5M8 13h4.5",
  chip: "M6 6h8v8H6zM8.5 3v3M11.5 3v3M8.5 14v3M11.5 14v3M3 8.5h3M3 11.5h3M14 8.5h3M14 11.5h3",
  agent:
    "M10 2.5v2.5M5 7.5h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14V9A1.5 1.5 0 0 1 5 7.5zM7.5 11v.5M12.5 11v.5",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L17 17",
  copy: "M7 7h9.5v9.5H7zM13 7V3.5H3.5V13H7",
  terminal: "M3 4h14v12H3zM6 8l2.5 2L6 12M10.5 12.5h3.5",
  close: "M5 5l10 10M15 5L5 15",
  share: "M10 3v9M6 7l4-4 4 4M4 12v4.5h12V12",
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
