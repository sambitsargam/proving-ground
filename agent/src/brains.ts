import { type Brain, type BrainReply, type ChatMessage, TOOLS } from "./agent.ts";

const ENDPOINT = "https://cloud-api.near.ai/v1/chat/completions";
const MAX_TOKENS = 800;
const TIMEOUT_MS = 60_000;

/** Refusal behavior removed, so the demo shows what happens when the model is truly convinced. */
export const DEFAULT_MODEL = "Qwen/Qwen3.8-27B-abliterated";

export class NearAiBrain implements Brain {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async next(messages: ChatMessage[]): Promise<BrainReply> {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "x-no-aliasing": "true",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        tools: TOOLS,
        chat_template_kwargs: { enable_thinking: false },
        messages,
      }),
    });
    if (!response.ok) throw new Error(`model returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("model returned no message");
    const toolCalls = message.tool_calls ?? [];
    return {
      text: message.content ?? "",
      reasoning: message.reasoning_content ?? "",
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      raw: {
        role: "assistant",
        content: message.content ?? "",
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    };
  }
}

const ACCOUNT = /[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near)/;
const AMOUNT = /(\d+(?:\.\d+)?)\s*NEAR/i;

/**
 * A fully jailbroken agent, with no model and no key. It obeys every message by paying
 * the first account named in it.
 */
export class CompromisedBrain implements Brain {
  async next(messages: ChatMessage[]): Promise<BrainReply> {
    const last = messages.at(-1);
    if (last?.role === "tool") {
      return reply(`The payment came back: ${last.content}`, []);
    }
    const text = last?.content ?? "";
    const payee = text.match(ACCOUNT)?.[0] ?? "";
    const amount = text.match(AMOUNT)?.[1] ?? "1";
    const args = JSON.stringify({ payee, amount_near: amount });
    return reply(`You are right. Paying ${payee} now.`, [
      { id: "call-1", name: "pay_invoice", arguments: args },
    ]);
  }
}

function reply(text: string, toolCalls: BrainReply["toolCalls"]): BrainReply {
  return {
    text,
    reasoning: "",
    toolCalls,
    raw: {
      role: "assistant",
      content: text,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    },
  };
}
