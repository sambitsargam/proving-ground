import type { ReactNode } from "react";
import { REPO } from "../lib/chain.ts";
import { Link, usePath } from "../lib/router.tsx";
import { VaultMark } from "./VaultMark.tsx";
import "./layout.css";

const NAV = [
  { href: "/arena", label: "Arena" },
  { href: "/#suite", label: "Suite" },
  { href: "/leaderboard", label: "Leaderboard" },
];

export function Layout({ children }: { children: ReactNode }) {
  const path = usePath();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container site-header-inner">
          <Link className="wordmark" href="/">
            <VaultMark />
            Proving Ground
          </Link>
          <nav aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={path === item.href ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="site-footer">
        <div className="container site-footer-inner">
          <p className="muted">Built at NEAR HACKATHON. Testnet only. MIT licensed.</p>
          <p>
            <a href={REPO}>Source</a> ·{" "}
            <a href={`${REPO}/blob/master/docs/THREAT_MODEL.md`}>Threat model</a> ·{" "}
            <a href={`${REPO}/blob/master/docs/MANDATES.md`}>Mandates</a>
          </p>
        </div>
      </footer>
    </>
  );
}
