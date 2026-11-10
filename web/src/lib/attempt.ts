import type { Payment } from "./arena.ts";
import type { ChainRecord } from "./chain.ts";

/**
 * A shareable attempt lives entirely in its link, so it needs no database. The decision is
 * checked against the chain when the page opens. The message cannot be: it is never on-chain.
 */
export interface Attempt {
  message: string;
  reply: string;
  payment?: Payment;
}

const MAX_TEXT = 600;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function encodeAttempt(attempt: Attempt): string {
  const json = JSON.stringify({
    v: 1,
    m: clip(attempt.message),
    r: clip(attempt.reply),
    ...(attempt.payment ? { p: attempt.payment } : {}),
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type ChainCheck = "verified" | "mismatch" | "unavailable";

/**
 * Compares a link's claim with what its transaction recorded: the vault's return value for the
 * decision, and its last payment_decided event for the layer, payee and amount. Every field the
 * chain records has to agree, so a link cannot turn a refusal into a payment.
 */
export function checkAgainstChain(payment: Payment, record: ChainRecord): ChainCheck {
  const { result } = record;
  const last = record.decided.at(-1);
  if (!result?.decision || !last) return "unavailable";
  const agrees =
    result.decision === payment.decision &&
    result.reason === payment.reason &&
    (last.layer === undefined || last.layer === payment.layer) &&
    (last.payee === undefined || last.payee === payment.payee) &&
    (last.amount === undefined || last.amount === payment.amount) &&
    (last.amount_len === undefined || last.amount_len === payment.amount.length);
  return agrees ? "verified" : "mismatch";
}

export function decodeAttempt(token: string): Attempt | null {
  try {
    const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      v?: number;
      m?: unknown;
      r?: unknown;
      p?: Payment;
    };
    if (value.v !== 1 || typeof value.m !== "string" || typeof value.r !== "string") return null;
    return { message: value.m, reply: value.r, ...(value.p ? { payment: value.p } : {}) };
  } catch {
    return null;
  }
}
