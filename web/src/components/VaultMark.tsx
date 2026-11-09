/** The flat mark of the vault: an obsidian cube with cobalt edges and a lime lock ring. */
export function VaultMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 3l11 6v14l-11 6-11-6V9l11-6z"
        fill="var(--surface-2)"
        stroke="var(--cobalt)"
        strokeWidth="1.5"
      />
      <path
        d="M5 9l11 6 11-6M16 15v14"
        fill="none"
        stroke="var(--cobalt)"
        strokeWidth="1.5"
        strokeOpacity="0.6"
      />
      <circle cx="21.5" cy="18.5" r="3" fill="none" stroke="var(--lime)" strokeWidth="1.5" />
    </svg>
  );
}

/** Black pill, cobalt border, lime check. */
export function TestedBadge() {
  return (
    <svg
      width="236"
      height="36"
      viewBox="0 0 236 36"
      role="img"
      aria-label="Tested by Proving Ground"
    >
      <rect x="0.5" y="0.5" width="235" height="35" rx="17.5" fill="#05060A" stroke="#2F5BFF" />
      <path
        d="M16 18.5l4 4 8-9"
        fill="none"
        stroke="#C6FF1A"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="40"
        y="23"
        fill="#F2F4F8"
        fontFamily="Inter Variable, Inter, system-ui, sans-serif"
        fontSize="14"
        fontWeight="600"
      >
        Tested by Proving Ground
      </text>
    </svg>
  );
}
