import { blobServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
blobServer().listen(port, () => {
  process.stdout.write(`blob store listening on ${port}\n`);
});
