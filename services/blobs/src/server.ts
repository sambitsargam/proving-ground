import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

const MAX_BLOB_BYTES = 128 * 1024;
const BLOB_PATH = /^\/blobs\/([0-9a-f]{64})$/;
const DEFAULT_MAX_BLOBS = 10_000;

/**
 * Sealed invoices, named by the sha256 of their content. It needs no login: a blob can
 * only be stored under its own hash, so nothing can be replaced, and only the checker
 * can read what is inside. The oldest blobs go first once it is full.
 */
export function blobServer(options: { maxBlobs?: number } = {}): Server {
  const maxBlobs = options.maxBlobs ?? DEFAULT_MAX_BLOBS;
  const blobs = new Map<string, Buffer>();
  return createServer((req, res) => {
    const send = (status: number, body: string | Buffer = "") => {
      res.writeHead(status);
      res.end(body);
    };
    const id = req.url?.match(BLOB_PATH)?.[1];
    if (!id) {
      send(req.url === "/health" ? 200 : 404);
      return;
    }
    if (req.method === "GET") {
      const blob = blobs.get(id);
      if (blob) send(200, blob);
      else send(404);
      return;
    }
    if (req.method !== "PUT") {
      send(405);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BLOB_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BLOB_BYTES) {
        send(413);
        return;
      }
      const body = Buffer.concat(chunks);
      if (createHash("sha256").update(body).digest("hex") !== id) {
        send(400);
        return;
      }
      if (!blobs.has(id) && blobs.size >= maxBlobs) {
        const oldest = blobs.keys().next().value;
        if (oldest !== undefined) blobs.delete(oldest);
      }
      blobs.set(id, body);
      send(201);
    });
  });
}
