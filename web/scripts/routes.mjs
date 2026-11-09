// Gives each page its own index.html, so any static host serves deep links with no rewrite
// rules. Shared attempts carry their data in the query string, so they need no route either.

import { copyFileSync, mkdirSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
for (const route of ["arena", "leaderboard", "attempt", "style", "poster"]) {
  mkdirSync(new URL(`${route}/`, dist), { recursive: true });
  copyFileSync(new URL("index.html", dist), new URL(`${route}/index.html`, dist));
}
copyFileSync(new URL("index.html", dist), new URL("404.html", dist));
