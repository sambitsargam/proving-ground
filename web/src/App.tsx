import { lazy, Suspense } from "react";
import { Layout } from "./components/Layout.tsx";
import { usePath } from "./lib/router.tsx";
import { Arena } from "./pages/Arena.tsx";
import { Attempt } from "./pages/Attempt.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Leaderboard } from "./pages/Leaderboard.tsx";
import { SocialCard } from "./pages/SocialCard.tsx";

// Neither is linked, and the poster pulls in three.js, so both stay out of the main bundle.
const Poster = lazy(() => import("./pages/Poster.tsx"));
const StyleSample = lazy(() =>
  import("./StyleSample.tsx").then((m) => ({ default: m.StyleSample })),
);

function NotFound() {
  return (
    <div className="container" style={{ padding: "var(--space-12) 0" }}>
      <h1>Not found</h1>
    </div>
  );
}

export function App() {
  const path = usePath();
  const route = path.replace(/\/$/, "") || "/";
  if (route === "/og") return <SocialCard />;
  if (route === "/poster" || route === "/style") {
    return (
      <Suspense fallback={null}>{route === "/poster" ? <Poster /> : <StyleSample />}</Suspense>
    );
  }
  let page = <NotFound />;
  if (route === "/") page = <Landing />;
  else if (route === "/arena") page = <Arena />;
  else if (route === "/leaderboard") page = <Leaderboard />;
  else if (route === "/attempt") {
    page = <Attempt token={new URLSearchParams(location.search).get("t") ?? ""} />;
  }
  return <Layout>{page}</Layout>;
}
