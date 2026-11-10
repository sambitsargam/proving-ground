import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { REPO, VAULT } from "../lib/chain.ts";
import { Link, usePath } from "../lib/router.tsx";
import { ToastProvider } from "./Toast.tsx";
import { VaultMark } from "./VaultMark.tsx";
import "./layout.css";

const NAV = [
  { href: "/arena", label: "Arena" },
  { href: "/#suite", label: "Suite" },
  { href: "/leaderboard", label: "Leaderboard" },
];

/** The nav's underline slides to the current page. */
function useIndicator(path: string) {
  const nav = useRef<HTMLElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active link changes with the path.
  useLayoutEffect(() => {
    const place = () => {
      const active = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
      setStyle(
        active
          ? ({
              opacity: 1,
              "--x": `${active.offsetLeft}px`,
              "--w": `${active.offsetWidth}px`,
            } as CSSProperties)
          : { opacity: 0 },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [path]);
  return [nav, style] as const;
}

export function Layout({ children }: { children: ReactNode }) {
  const path = usePath();
  const [nav, indicator] = useIndicator(path);
  return (
    <ToastProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container site-header-inner">
          <Link className="wordmark" href="/">
            <VaultMark />
            Proving Ground
          </Link>
          <nav aria-label="Main" ref={nav}>
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={path === item.href ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
            <span className="nav-indicator" style={indicator} aria-hidden="true" />
          </nav>
          <a className="network-pill" href={`https://testnet.nearblocks.io/address/${VAULT}`}>
            <span className="live-dot" aria-hidden="true" />
            NEAR testnet
          </a>
        </div>
      </header>
      <main id="main" key={path} className="page">
        {children}
      </main>
      <footer className="site-footer">
        <div className="container site-footer-inner">
          <div className="footer-brand">
            <Link className="wordmark" href="/">
              <VaultMark />
              Proving Ground
            </Link>
            <p className="muted">
              Payment mandates for AI agents. The model can only say no. Built at NEAR HACKATHON,
              testnet only, MIT licensed.
            </p>
          </div>
          <nav className="footer-links" aria-label="Project">
            <a href={REPO}>Source</a>
            <a href={`${REPO}/blob/master/docs/THREAT_MODEL.md`}>Threat model</a>
            <a href={`${REPO}/blob/master/docs/MANDATES.md`}>Mandates</a>
            <a href={`${REPO}/blob/master/docs/ARCHITECTURE.md`}>Architecture</a>
          </nav>
        </div>
      </footer>
    </ToastProvider>
  );
}
