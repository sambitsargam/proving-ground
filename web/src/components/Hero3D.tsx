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
 * The poster paints first. The 3D scene loads after that, and only on capable desktops.
 * Phones, reduced motion and no WebGL keep the poster.
 */
export function Hero3D() {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!canRun3D()) return;
    const start = () => setLive(true);
    const idle = window.requestIdleCallback?.(start, { timeout: 1500 });
    const timer = idle === undefined ? window.setTimeout(start, 300) : undefined;
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (timer !== undefined) window.clearTimeout(timer);
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
