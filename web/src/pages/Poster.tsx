import VaultScene from "../three/VaultScene.tsx";

/** A still of the vault, rendered for the poster image and the social card. Not linked. */
export default function Poster() {
  return (
    <div style={{ width: "100vw", height: "100vh", background: "var(--bg)" }}>
      <VaultScene still />
    </div>
  );
}
