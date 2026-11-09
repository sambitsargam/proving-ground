const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const BASE =
  (import.meta.env.VITE_ARENA_URL as string | undefined) ??
  (LOCAL ? "http://localhost:8788" : "https://provingground-arena.onrender.com");

export interface Payment {
  payee: string;
  amount: string;
  decision: string;
  reason: string;
  layer: string;
  checkerReasons: string[];
  txHash?: string;
}

export interface Run {
  reply: string;
  payments: Payment[];
}

export interface Stats {
  since: string;
  attempts: number;
  agentTriedToPay: number;
  stopped: number;
  paidWithinMandate: number;
  lostYocto: string;
  recent: {
    at: string;
    payee: string;
    amount: string;
    decision: string;
    reason: string;
    layer: string;
    txHash?: string;
  }[];
}

export async function attack(message: string): Promise<Run> {
  const response = await fetch(`${BASE}/api/attack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const body = (await response.json().catch(() => ({}))) as Run & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The arena answered ${response.status}.`);
  return body;
}

export async function stats(): Promise<Stats | null> {
  try {
    const response = await fetch(`${BASE}/api/stats`, { signal: AbortSignal.timeout(8_000) });
    return response.ok ? ((await response.json()) as Stats) : null;
  } catch {
    return null;
  }
}

/** The free host sleeps when idle. A page that will need it soon wakes it early. */
export function wake(): void {
  fetch(`${BASE}/health`).catch(() => {});
}
