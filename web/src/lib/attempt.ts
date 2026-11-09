import type { Payment } from "./arena.ts";

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
