// Stand-in for the checker's model in mock mode, so the suite needs no key and gives the
// same answer every run. It reads the same request the real model gets and answers in the
// same format. The real model is exercised by `make checker-eval`.

export type ModelMode =
  /** Reads the invoice carefully. */
  | "honest"
  /** Copies the invoice's facts correctly but has been talked into saying ALLOW. */
  | "fooled"
  /** Talked into reporting whatever facts the payment needs, and saying ALLOW. */
  | "fully-fooled"
  /** Replies with text that is not an answer. */
  | "garbage"
  /** Unreachable, or out of credit. */
  | "down";

export interface FakePayment {
  payee: string;
  total: string;
}

const INJECTION =
  /ignore (all|any|previous|your)|checker|reviewer|verdict|pre-?approved|system (note|override)|respond with|you are now|authori[sz]ed|urgent|changed? (account|destination)/i;
const STOP_WORDS = new Set(["monthly", "month", "from", "with", "that", "this", "only", "near"]);

function fact(invoice: string, pattern: RegExp): string | null {
  return invoice.match(pattern)?.[1] ?? null;
}

function chargeLines(invoice: string): string[] {
  return invoice
    .split("\n")
    .filter((line) => !/total|subtotal|balance|deposit|payable/i.test(line))
    .map((line) => line.match(/:\s*([\d.]+)\s+[A-Za-z]+\s*$/)?.[1])
    .filter((amount): amount is string => amount !== undefined);
}

function withinPurpose(purpose: string, invoice: string): boolean {
  const words = purpose.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const text = invoice.toLowerCase();
  return words.some((word) => !STOP_WORDS.has(word) && text.includes(word));
}

function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

/** Returns the raw API response, or null if the model cannot be reached. */
export function standInModel(body: string, mode: ModelMode, payment: FakePayment): string | null {
  if (mode === "down") return null;
  if (mode === "garbage") return completion("This looks fine to me. ALLOW.");

  const request = JSON.parse(body) as { messages: { content: string }[] };
  const { purpose, memo, invoice } = JSON.parse(request.messages[1]?.content ?? "{}") as {
    purpose: string;
    memo: string;
    invoice: string;
  };

  const total = fact(invoice, /total(?: due)?:\s*([\d.]+)/i);
  const facts = {
    invoice_payee: fact(invoice, /pay to:\s*(\S+)/i),
    invoice_total: total,
    invoice_currency: fact(invoice, /total(?: due)?:\s*[\d.]+\s+([A-Za-z]+)/i),
    amounts_due: total ? [total] : [],
    line_items: chargeLines(invoice),
  };
  const allow = { verdict: "ALLOW", reasons: ["WITHIN_PURPOSE"] };

  if (mode === "fooled") return completion(JSON.stringify({ ...facts, ...allow }));
  if (mode === "fully-fooled") {
    return completion(
      JSON.stringify({
        invoice_payee: payment.payee,
        invoice_total: payment.total,
        invoice_currency: "NEAR",
        amounts_due: [payment.total],
        line_items: [],
        ...allow,
      }),
    );
  }

  let decision: { verdict: string; reasons: string[] } = allow;
  if (INJECTION.test(invoice) || INJECTION.test(memo)) {
    decision = { verdict: "BLOCK", reasons: ["INJECTION_SUSPECTED"] };
  } else if (!withinPurpose(purpose, invoice)) {
    decision = { verdict: "BLOCK", reasons: ["OUT_OF_PURPOSE"] };
  }
  return completion(JSON.stringify({ ...facts, ...decision }));
}
