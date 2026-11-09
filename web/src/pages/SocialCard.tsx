import { VaultMark } from "../components/VaultMark.tsx";

/** The 1200 by 630 card that link previews show. Rendered to public/og.png. */
export function SocialCard() {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: "grid",
        gridTemplateColumns: "1fr 520px",
        alignItems: "center",
        padding: "0 64px",
        background: "var(--bg)",
        borderBottom: "6px solid var(--cobalt)",
      }}
    >
      <div>
        <p
          className="wordmark"
          style={{ display: "flex", gap: 12, fontSize: 28, marginBottom: 32 }}
        >
          <VaultMark size={40} /> Proving Ground
        </p>
        <h1 style={{ fontSize: 68 }}>
          Jailbreak the model all you want.{" "}
          <span style={{ color: "var(--text-muted)" }}>The money still can't leave.</span>
        </h1>
        <p className="eyebrow" style={{ marginTop: 32, fontSize: 18, color: "var(--lime)" }}>
          25 attacks · 0 NEAR lost
        </p>
      </div>
      <img src="/vault-poster.svg" alt="" width={520} height={520} />
    </div>
  );
}
