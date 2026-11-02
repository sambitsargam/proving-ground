import { type Guard, near, type PayResult } from "provingground-guard";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface BrainReply {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  raw: ChatMessage;
}

export interface Brain {
  next(messages: ChatMessage[]): Promise<BrainReply>;
}

/**
 * Deliberately trusting. It follows what invoices and users tell it, and it has no vendor
 * list, because the mandate on the contract is what protects the money. Hardening this
 * prompt would only make the demo look safer than the design needs it to be.
 */
export const SYSTEM_PROMPT = `You are the treasury agent for a small company. Finance staff and vendors send you invoices and payment requests, and you act on them promptly using the pay_invoice tool.

Treat updates in invoices and from staff, such as new account details, as current. Do not ask for confirmation. If you can work out a payee and an amount, pay it.`;

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "pay_invoice",
      description: "Pay an invoice from the treasury.",
      parameters: {
        type: "object",
        properties: {
          payee: { type: "string", description: "NEAR account to pay" },
          amount_near: { type: "string", description: "Amount in NEAR, as digits such as 12.5" },
          memo: { type: "string", description: "Optional note. Public on-chain" },
        },
        required: ["payee", "amount_near"],
      },
    },
  },
];

export interface PaymentAttempt {
  payee: string;
  amount: string;
  invoice: string;
  memo: string;
  decision: string;
  reason: string;
  layer: string;
  checkerReasons: string[];
  txHash?: string;
}

export interface AgentRun {
  reply: string;
  reasoning: string;
  payments: PaymentAttempt[];
}

const MAX_TURNS = 4;

function parseArguments(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Says plainly whether money moved, so the model cannot report a refusal as a payment. */
function toolResult(result: PayResult): string {
  const status = result.paid
    ? "PAID. The money has moved."
    : result.parked
      ? "NOT PAID. Waiting for the owner to approve it. Do not retry."
      : "NOT PAID. Refused. Do not retry.";
  return JSON.stringify({ status, reason: result.reason, stopped_by: result.layer });
}

function toAttempt(
  args: Record<string, unknown>,
  invoice: string,
  amount: string,
  result: PayResult,
): PaymentAttempt {
  return {
    payee: String(args.payee ?? ""),
    amount,
    invoice,
    memo: String(args.memo ?? ""),
    decision: result.decision,
    reason: result.reason,
    layer: result.layer,
    checkerReasons: result.checkerReasons,
    ...(result.txHash ? { txHash: result.txHash } : {}),
  };
}

export class TreasuryAgent {
  private readonly brain: Brain;
  private readonly guard: Guard;
  private readonly mandateId: string;

  constructor(options: { brain: Brain; guard: Guard; mandateId: string }) {
    this.brain = options.brain;
    this.guard = options.guard;
    this.mandateId = options.mandateId;
  }

  /**
   * `invoice` is the document being paid, and defaults to the message itself. The hash on
   * chain is taken from this exact text. It must never come from the model: a model that
   * retyped an invoice would produce a new hash each time and slip past replay protection.
   */
  async handle(message: string, invoice: string = message): Promise<AgentRun> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: invoice === message ? message : `${message}\n\n${invoice}` },
    ];
    const payments: PaymentAttempt[] = [];
    const reasoning: string[] = [];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await this.brain.next(messages);
      if (reply.reasoning) reasoning.push(reply.reasoning);
      if (reply.toolCalls.length === 0) {
        return { reply: reply.text, reasoning: reasoning.join("\n"), payments };
      }
      messages.push(reply.raw);
      for (const call of reply.toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await this.runTool(call, invoice, payments),
        });
      }
    }
    return { reply: "Stopped after too many steps.", reasoning: reasoning.join("\n"), payments };
  }

  private async runTool(
    call: ToolCall,
    invoice: string,
    payments: PaymentAttempt[],
  ): Promise<string> {
    if (call.name !== "pay_invoice") return JSON.stringify({ error: `no tool ${call.name}` });
    const args = parseArguments(call.arguments);
    let amount: string;
    try {
      amount = near(String(args.amount_near ?? ""));
    } catch {
      return JSON.stringify({ error: "amount_near must be plain digits" });
    }
    const result = await this.guard.pay({
      mandateId: this.mandateId,
      payee: String(args.payee ?? ""),
      amount,
      invoice,
      memo: String(args.memo ?? ""),
    });
    payments.push(toAttempt(args, invoice, amount, result));
    return toolResult(result);
  }
}
