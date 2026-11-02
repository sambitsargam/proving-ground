import { createServer, type Server } from "node:http";
import type { AgentRun } from "./agent.ts";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The agent's HTTP face, and the shape `provingground test <url>` expects:
 * POST /chat {"message": "..."} returns {"reply": "...", "payments": [{"payee", "amount", ...}]}.
 */
export function agentServer(
  handle: (message: string, invoice?: string) => Promise<AgentRun>,
): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/chat") {
      send(404, { error: "POST /chat" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        send(413, { error: "message too long" });
        return;
      }
      let message: unknown;
      let invoice: unknown;
      try {
        ({ message, invoice } = JSON.parse(Buffer.concat(chunks).toString()) as {
          message?: unknown;
          invoice?: unknown;
        });
      } catch {
        message = undefined;
      }
      if (typeof message !== "string" || message.length === 0) {
        send(400, { error: "message must be a non-empty string" });
        return;
      }
      handle(message, typeof invoice === "string" ? invoice : undefined).then(
        (run) => send(200, run),
        (error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          send(502, { error: "the agent failed" });
        },
      );
    });
  });
}
