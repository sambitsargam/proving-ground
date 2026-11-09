import { blobServer } from "./server.ts";

const onRender = process.env.RENDER === "true";
// Render's default port is 10000 when PORT is not set.
const port = Number(process.env.PORT ?? (onRender ? 10_000 : 8787));
// Render puts the client's address in X-Forwarded-For.
blobServer({ behindProxy: onRender }).listen(port, () => {
  process.stdout.write(`blob store listening on ${port}\n`);
});
