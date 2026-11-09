import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

const MAX_BLOB_BYTES = 128 * 1024;
const BLOB_PATH = /^\/blobs\/([0-9a-f]{64})$/;
const DEFAULT_MAX_BLOBS = 10_000;
/** Well under the 512 MB a free Render instance has. */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_UPLOADS_PER_MINUTE = 120;
const MINUTE_MS = 60_000;

export interface BlobServerOptions {
  maxBlobs?: number;
  maxTotalBytes?: number;
  uploadsPerMinute?: number;
  /** Trust X-Forwarded-For, as behind Render's proxy. */
  behindProxy?: boolean;
}

/**
 * Sealed invoices, named by the sha256 of their content. It needs no login: a blob can
 * only be stored under its own hash, so nothing can be replaced, and only the checker
 * can read what is inside. The oldest blobs go first once it is full. A blob only matters
 * between the agent's upload and the checker's read, a few seconds later.
 */
export function blobServer(options: BlobServerOptions = {}): Server {
  const maxBlobs = options.maxBlobs ?? DEFAULT_MAX_BLOBS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const uploadsPerMinute = options.uploadsPerMinute ?? DEFAULT_UPLOADS_PER_MINUTE;
  const blobs = new Map<string, Buffer>();
  let totalBytes = 0;
  const uploads = new Map<string, { windowStart: number; count: number }>();

  const clientOf = (req: IncomingMessage): string => {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    return (options.behindProxy && first) || req.socket.remoteAddress || "unknown";
  };

  const allowUpload = (client: string): boolean => {
    const now = Date.now();
    const entry = uploads.get(client);
    if (!entry || now - entry.windowStart >= MINUTE_MS) {
      if (uploads.size > 10_000) uploads.clear();
      uploads.set(client, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= uploadsPerMinute;
  };

  const store = (id: string, body: Buffer) => {
    if (blobs.has(id)) return;
    while (blobs.size > 0 && (blobs.size >= maxBlobs || totalBytes + body.length > maxTotalBytes)) {
      const oldest = blobs.keys().next().value as string;
      totalBytes -= blobs.get(oldest)?.length ?? 0;
      blobs.delete(oldest);
    }
    blobs.set(id, body);
    totalBytes += body.length;
  };

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
    if (!allowUpload(clientOf(req))) {
      req.resume();
      send(429);
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
      store(id, body);
      send(201);
    });
  });
}
