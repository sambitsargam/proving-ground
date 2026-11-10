import { lazy, Suspense, useEffect, useState } from "react";

const VaultScene = lazy(() => import("../three/VaultScene.tsx"));

function canRun3D(): boolean {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (window.matchMedia("(max-width: 767px)").matches) return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return false;
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

/**
 * The poster paints first. The 3D scene loads once the page is quiet, and only on capable desktops.
 * Phones, reduced motion and no WebGL keep the poster.
 */
export function Hero3D() {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!canRun3D()) return;
    // three.js is the heaviest thing on the page. Wait for the page to finish loading and go
    // quiet, so it never delays the first paint or the first interaction.
    let idle: number | undefined;
    let timer: number | undefined;
    const start = () => setLive(true);
    const schedule = () => {
      timer = window.setTimeout(() => {
        idle = window.requestIdleCallback?.(start, { timeout: 2000 });
        if (idle === undefined) start();
      }, 1800);
    };
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => {
      window.removeEventListener("load", schedule);
      if (timer !== undefined) window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
    };
  }, []);

  return (
    <div className="hero-vault">
      <img
        className="hero-poster"
        src="/vault-poster.svg"
        alt=""
        width={640}
        height={640}
        fetchPriority="high"
      />
      {live && (
        <Suspense fallback={null}>
          <div className="hero-canvas">
            <VaultScene />
          </div>
        </Suspense>
      )}
    </div>
  );
}
