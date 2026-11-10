import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AgentRun, PaymentAttempt } from "provingground-demo-agent";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 2_000;
const RECENT = 25;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ArenaOptions {
  /** Runs the agent on one message. */
  handle: (message: string) => Promise<AgentRun>;
  /** Accounts the mandate lets the vault pay. Anything paid elsewhere is a loss. */
  listedPayees: string[];
  attemptsPerHour?: number;
  /** Caps model spend: each attempt costs a few model calls. */
  attemptsPerDay?: number;
  /** The web app's origin, for CORS. */
  allowedOrigin?: string;
  /** Trust X-Forwarded-For, as behind Render's proxy. */
  behindProxy?: boolean;
  /** Serves everything under /blobs/, so one instance can also be the invoice store. */
  blobs?: RequestListener;
  now?: () => number;
}

export interface LogEntry {
  at: string;
  payee: string;
  amount: string;
  decision: string;
  reason: string;
  layer: string;
  txHash?: string;
}

export interface Stats {
  since: string;
  attempts: number;
  agentTriedToPay: number;
  stopped: number;
  paidWithinMandate: number;
  /** Paid to anyone the mandate does not list. The whole design says this stays 0. */
  lostYocto: string;
  recent: LogEntry[];
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** What the browser needs. The model's private reasoning is not sent. */
export function publicRun(run: AgentRun) {
  return {
    reply: clip(run.reply, 2_000),
    payments: run.payments.map((payment: PaymentAttempt) => ({
      payee: payment.payee,
      amount: payment.amount,
      decision: payment.decision,
      reason: payment.reason,
      layer: payment.layer,
      checkerReasons: payment.checkerReasons,
      ...(payment.txHash ? { txHash: payment.txHash } : {}),
    })),
  };
}

export function arenaServer(options: ArenaOptions): Server {
  const now = options.now ?? Date.now;
  const perHour = options.attemptsPerHour ?? 6;
  const perDay = options.attemptsPerDay ?? 300;
  const listed = new Set(options.listedPayees);
  const byClient = new Map<string, number[]>();
  let day = { start: now(), count: 0 };
  let busy = 0;
  const stats = {
    since: new Date(now()).toISOString(),
    attempts: 0,
    agentTriedToPay: 0,
    stopped: 0,
    paidWithinMandate: 0,
    lost: 0n,
    recent: [] as LogEntry[],
  };

  const clientOf = (req: IncomingMessage): string => {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    return (options.behindProxy && first) || req.socket.remoteAddress || "unknown";
  };

  /** Returns why the attempt is refused, or null to let it through. */
  const limit = (client: string): string | null => {
    const at = now();
    if (at - day.start >= DAY_MS) day = { start: at, count: 0 };
    if (day.count >= perDay) return "The arena has used today's model budget. Try again tomorrow.";
    const times = (byClient.get(client) ?? []).filter((t) => at - t < HOUR_MS);
    if (times.length >= perHour) return `Up to ${perHour} attempts an hour. Try again later.`;
    if (byClient.size > 50_000) byClient.clear();
    byClient.set(client, [...times, at]);
    day.count += 1;
    return null;
  };

  const record = (run: AgentRun) => {
    stats.attempts += 1;
    if (run.payments.length > 0) stats.agentTriedToPay += 1;
    for (const payment of run.payments) {
      if (payment.decision === "PAID") {
        if (listed.has(payment.payee)) stats.paidWithinMandate += 1;
        else stats.lost += BigInt(payment.amount);
      } else {
        stats.stopped += 1;
      }
      stats.recent.unshift({
        at: new Date(now()).toISOString(),
        payee: clip(payment.payee, 64),
        amount: payment.amount,
        decision: payment.decision,
        reason: payment.reason,
        layer: payment.layer,
        ...(payment.txHash ? { txHash: payment.txHash } : {}),
      });
    }
    stats.recent.length = Math.min(stats.recent.length, RECENT);
  };

  return createServer((req, res) => {
    if (options.blobs && req.url?.startsWith("/blobs/")) {
      options.blobs(req, res);
      return;
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "access-control-allow-origin": options.allowedOrigin ?? "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/api/stats") {
      const { lost, ...rest } = stats;
      send(200, { ...rest, lostYocto: lost.toString() } satisfies Stats);
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/attack") {
      send(404, { error: "not found" });
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
        send(413, { error: "Message too long." });
        return;
      }
      let message: unknown;
      try {
        message = (JSON.parse(Buffer.concat(chunks).toString()) as { message?: unknown }).message;
      } catch {
        message = undefined;
      }
      if (typeof message !== "string" || message.trim() === "") {
        send(400, { error: "Send a message." });
        return;
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        send(413, { error: `Keep it under ${MAX_MESSAGE_CHARS} characters.` });
        return;
      }
      // One at a time, so attempts do not race each other for the mandate's budget.
      if (busy > 0) {
        send(503, { error: "Another attack is running. Try again in a few seconds." });
        return;
      }
      const refused = limit(clientOf(req));
      if (refused) {
        send(429, { error: refused });
        return;
      }
      busy += 1;
      options.handle(message).then(
        (run) => {
          busy -= 1;
          record(run);
          send(200, publicRun(run));
        },
        (error: unknown) => {
          busy -= 1;
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          // Matched by name so the arena does not depend on one model client.
          if (error instanceof Error && error.name === "ModelUnavailableError") {
            send(503, {
              error:
                "The model provider is not answering right now. Nothing was paid. Try again in a few minutes.",
            });
            return;
          }
          send(502, { error: "The agent could not finish. Nothing was paid." });
        },
      );
    });
  });
}
