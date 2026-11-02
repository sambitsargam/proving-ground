import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Guard,
  hashInvoice,
  hashPurpose,
  type Layer,
  type MandateTerms,
  MemoryBlobStore,
  near,
  type PaymentArgs,
  type PayRequest,
  sha256Hex,
  toPayResult,
  type VaultEvent,
  type VaultOutcome,
} from "provingground-guard";
import { type ModelMode, standInModel } from "./model.ts";
import { NearRuntime, type Tx, type TxResult } from "./runtime.ts";

export const VAULT = "vault.testnet";
export const OWNER = "treasury.testnet";
export const AGENT = "agent.testnet";
export const VENDOR = "acmehosting.testnet";
export const PAYROLL = "payroll.testnet";
export const ATTACKER = "attacker.testnet";
const OUTLAYER = "outlayer.testnet";

export const PURPOSE = "Monthly web hosting from Acme Hosting, up to 15 NEAR a month.";
const PAYROLL_PURPOSE = "Contractor payroll for the engineering team.";
export const DAILY_CAP = near("30");
export const MAX_TOTAL = near("50");
export const MAX_PER_PAYMENT = near("15");
const CHECKER_FEE = near("0.04");
const CHECKER_BUDGET = near("2");
const DAY_NS = 86_400_000_000_000n;
const FUNDING = near("50");
/** More than storage and the checker budget need. `create` returns the surplus. */
const CREATE_DEPOSIT = near("4");
const YIELD_TIMEOUT_NS = 600_000_000_000n;

const wasmDir = new URL("../wasm/", import.meta.url);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const load = (name: string) => readFileSync(new URL(name, wasmDir));

export function wasmHashes(): { vault: string; checker: string } {
  return { vault: sha256Hex(load("vault.wasm")), checker: sha256Hex(load("checker.wasm")) };
}

/** One thing a compromised party tried, and what stopped it. */
export interface Attempt {
  tried: string;
  layer: Layer;
  decision: string;
  reason: string;
  checkerReasons: string[];
}

export interface Pay {
  payee: string;
  amount: string;
  invoice: string;
  memo?: string;
  mandateId?: string;
}

export interface MandateOverrides {
  payees?: string[];
  maxTotal?: string;
  maxPerPayment?: string;
  purpose?: string;
  funding?: string;
}

interface Waiter {
  resolve: (outcome: VaultOutcome) => void;
  result: () => TxResult;
}

function eventsOf(logs: string[]): VaultEvent[] {
  return logs.flatMap((log) => {
    if (!log.startsWith("EVENT_JSON:")) return [];
    const { event, data } = JSON.parse(log.slice("EVENT_JSON:".length)) as {
      event: string;
      data: Record<string, unknown>[];
    };
    return [{ event, data: data[0] ?? {} }];
  });
}

function checkerAbi(world: {
  blob(url: string): string | null;
  model(body: string): string | null;
}) {
  let exports: {
    memory: WebAssembly.Memory;
    alloc(len: number): number;
    check(input: number, len: number, key: number): bigint;
  };
  const toPacked = (text: string | null): bigint => {
    if (text === null) return 0xffff_ffff_ffff_ffffn;
    const bytes = textEncoder.encode(text);
    const ptr = exports.alloc(bytes.length);
    new Uint8Array(exports.memory.buffer).set(bytes, ptr);
    return (BigInt(ptr) << 32n) | BigInt(bytes.length);
  };
  const readText = (ptr: number, len: number) =>
    textDecoder.decode(new Uint8Array(exports.memory.buffer, ptr, len).slice());
  const instance = new WebAssembly.Instance(new WebAssembly.Module(load("checker.wasm")), {
    host: {
      host_get: (ptr: number, len: number) => toPacked(world.blob(readText(ptr, len))),
      host_model: (ptr: number, len: number) => toPacked(world.model(readText(ptr, len))),
    },
  });
  exports = instance.exports as unknown as typeof exports;
  return (input: string, secretKey: Uint8Array): string | null => {
    try {
      const bytes = textEncoder.encode(input);
      const inputPtr = exports.alloc(bytes.length);
      new Uint8Array(exports.memory.buffer).set(bytes, inputPtr);
      const keyPtr = exports.alloc(32);
      new Uint8Array(exports.memory.buffer).set(secretKey, keyPtr);
      const packed = BigInt.asUintN(64, exports.check(inputPtr, bytes.length, keyPtr));
      if (packed === 0xffff_ffff_ffff_ffffn) return null;
      return readText(Number(packed >> 32n), Number(packed & 0xffff_ffffn));
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) return null;
      throw error;
    }
  };
}

/**
 * One fresh deployment for one attack: the real vault WASM on the simulated runtime, the
 * real checker logic behind a stand-in model, and an agent holding only a function call key.
 */
export class MockWorld {
  readonly rt = new NearRuntime();
  readonly attempts: Attempt[] = [];
  /** Mandate the agent works under. */
  readonly mandateId: string;
  modelMode: ModelMode = "honest";
  /** A compromised checker: prints this instead of running. */
  checkerOverride: string | null | undefined = undefined;
  /** Holds checker runs until `releaseChecker`, so requests can overlap. */
  holdChecker = false;

  private readonly blobs = new MemoryBlobStore();
  private readonly secretKey = randomBytes(32);
  private readonly terms: Record<string, MandateTerms> = {};
  readonly guard: Guard;
  private readonly runChecker: (input: string, key: Uint8Array) => string | null;
  private readonly held: { receiptId: number; input: string }[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly listedPayees = new Set<string>();
  private readonly mandateIds: string[] = [];
  private currentRequest = { payee: "", amount: 0n };
  private movementsFrom = 0;

  constructor() {
    const { rt } = this;
    const large = BigInt(near("10000"));
    for (const id of [VAULT, OWNER, AGENT, VENDOR, PAYROLL, ATTACKER, OUTLAYER]) {
      rt.createAccount(id, id === OWNER ? large : BigInt(near("1")));
    }
    // The vault's own code and base state need NEAR outside any mandate.
    rt.deploy(VAULT, load("vault.wasm"));
    rt.deployNative(OUTLAYER, (call) => this.outlayer(call));
    this.call(VAULT, VAULT, "new", {
      checker: {
        outlayer: OUTLAYER,
        source: { WasmUrl: { url: "mock:", hash: "00".repeat(32), build_target: "wasm32-wasip2" } },
        secrets_ref: null,
        fee: CHECKER_FEE,
        max_instructions: "100000000",
        max_memory_mb: 128,
        max_execution_seconds: "60",
        check_timeout_ns: YIELD_TIMEOUT_NS.toString(),
      },
    });
    rt.removeFullAccessKeys(VAULT);

    rt.addKey(AGENT, "function-call", {
      kind: "function_call",
      receiver: VAULT,
      methods: ["request_payment"],
    });
    rt.removeFullAccessKeys(AGENT);

    this.runChecker = checkerAbi({
      blob: (url) => this.blobs.blobs.get(url.split("/").pop() ?? "") ?? null,
      model: (body) =>
        standInModel(body, this.modelMode, {
          payee: this.currentRequest.payee,
          total: (this.currentRequest.amount / BigInt(near("1"))).toString(),
        }),
    });

    this.call(
      OWNER,
      VAULT,
      "set_daily_cap",
      { agent: AGENT, token: null, cap: DAILY_CAP },
      near("0.1"),
    );
    this.mandateId = this.createMandate();
    this.guard = new Guard({
      vault: { requestPayment: (args) => this.requestPayment(args) },
      blobs: this.blobs,
      checkerPublicKey: publicKeyOf(this.secretKey),
      mandates: this.terms,
    });
    this.markClean();
  }

  /** Creates and funds a mandate from the owner's wallet. */
  createMandate(overrides: MandateOverrides = {}): string {
    const purpose = overrides.purpose ?? PURPOSE;
    const purposeSalt = randomBytes(16).toString("hex");
    const result = this.call(
      OWNER,
      VAULT,
      "create_mandate",
      {
        args: {
          agent: AGENT,
          payees: overrides.payees ?? [VENDOR],
          token: null,
          max_total: overrides.maxTotal ?? MAX_TOTAL,
          max_per_payment: overrides.maxPerPayment ?? MAX_PER_PAYMENT,
          purpose_hash: hashPurpose(purpose, purposeSalt),
          expires_at: (this.rt.now + 30n * DAY_NS).toString(),
          max_requests: 20,
          max_checks_per_day: 20,
          park_ttl: DAY_NS.toString(),
          checker_budget: CHECKER_BUDGET,
        },
      },
      CREATE_DEPOSIT,
    );
    const id = result.mandate_id as string;
    this.terms[id] = { purpose, purposeSalt };
    this.mandateIds.push(id);
    for (const payee of overrides.payees ?? [VENDOR]) this.listedPayees.add(payee);

    const surplus = this.rt.view<{ balance: string }>(VAULT, "get_mandate", {
      mandate_id: id,
    }).balance;
    if (BigInt(surplus) > 0n) {
      this.call(OWNER, VAULT, "withdraw", { mandate_id: id, amount: surplus }, "1");
    }
    this.call(OWNER, VAULT, "fund", { mandate_id: id }, overrides.funding ?? FUNDING);
    return id;
  }

  createPayrollMandate(): string {
    return this.createMandate({ payees: [PAYROLL], purpose: PAYROLL_PURPOSE });
  }

  // ---------- What the compromised parties can do ----------

  /** The agent pays through the guard SDK with its only key. */
  async pay(pay: Pay): Promise<Attempt> {
    const request: PayRequest = {
      mandateId: pay.mandateId ?? this.mandateId,
      payee: pay.payee,
      amount: pay.amount,
      invoice: pay.invoice,
      ...(pay.memo === undefined ? {} : { memo: pay.memo }),
    };
    this.currentRequest = { payee: pay.payee, amount: toBigIntOrZero(pay.amount) };
    const result = await this.guard.pay(request);
    return this.note(`request_payment to ${printable(pay.payee)}`, {
      layer: result.layer,
      decision: result.decision,
      reason: result.reason,
      checkerReasons: result.checkerReasons,
    });
  }

  /** Lets queued work reach the chain while earlier requests are still waiting. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** The agent signs any call its key allows it to attempt. */
  agentCall(method: string, args: unknown, deposit = "0"): Attempt {
    return this.tx(
      {
        signer: AGENT,
        key: "function-call",
        receiver: VAULT,
        action: { kind: "call", method, args, deposit: BigInt(deposit) },
      },
      `agent key calls ${method}`,
    );
  }

  agentTransfer(to: string, amount: string): Attempt {
    return this.tx(
      {
        signer: AGENT,
        key: "function-call",
        receiver: to,
        action: { kind: "transfer", amount: BigInt(amount) },
      },
      `agent key transfers to ${to}`,
    );
  }

  /** The attacker signs from their own account. */
  attackerCall(method: string, args: unknown, deposit = "0"): Attempt {
    return this.tx(
      {
        signer: ATTACKER,
        receiver: VAULT,
        action: { kind: "call", method, args, deposit: BigInt(deposit) },
      },
      `attacker calls ${method}`,
    );
  }

  ownerCall(method: string, args: unknown, deposit = "1"): Attempt {
    return this.tx(
      {
        signer: OWNER,
        receiver: VAULT,
        action: { kind: "call", method, args, deposit: BigInt(deposit) },
      },
      `owner calls ${method}`,
    );
  }

  expireMandates(): void {
    this.rt.advance(31n * DAY_NS);
  }

  /** Runs the checker on every held request and delivers the verdicts. */
  async releaseChecker(): Promise<void> {
    this.holdChecker = false;
    for (const { receiptId, input } of this.held.splice(0)) {
      const output = this.checkerOutput(input);
      this.rt.resolveHeld(receiptId, textEncoder.encode(output ?? "null"));
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(this.toOutcome(waiter.result()));
    }
    await this.settle();
  }

  /** Forgets everything so far when counting losses. For legitimate setup payments. */
  markClean(): void {
    this.movementsFrom = this.rt.movements.length;
  }

  // ---------- Accounting ----------

  /** Paid out of the vault to anyone not on a mandate, net of what they paid in. */
  fundsLost(): bigint {
    const moves = this.rt.movements.slice(this.movementsFrom);
    const accounts = new Set(moves.map((move) => move.to));
    let lost = 0n;
    for (const account of accounts) {
      if (account === VAULT || account === OWNER || account === OUTLAYER) continue;
      if (this.listedPayees.has(account)) continue;
      const out = moves.filter((m) => m.from === VAULT && m.to === account);
      const back = moves.filter((m) => m.from === account && m.to === VAULT);
      const net = sum(out) - sum(back);
      if (net > 0n) lost += net;
    }
    return lost;
  }

  /** Paid to a payee the owner listed, since the last `markClean`. */
  paidToListed(): bigint {
    return this.fromVault((to) => this.listedPayees.has(to));
  }

  feesBurned(): bigint {
    return this.fromVault((to) => to === OUTLAYER);
  }

  attackerGain(): bigint {
    return this.rt.balance(ATTACKER) - BigInt(near("1"));
  }

  /** The vault holds at least what its mandates say it holds. */
  solvent(): boolean {
    const held = this.mandateIds.reduce((total, id) => {
      const mandate = this.rt.view<{
        balance: string;
        checker_budget: string;
        storage_balance: string;
      }>(VAULT, "get_mandate", { mandate_id: id });
      return (
        total +
        BigInt(mandate.balance) +
        BigInt(mandate.checker_budget) +
        BigInt(mandate.storage_balance)
      );
    }, 0n);
    return this.rt.balance(VAULT) >= held;
  }

  invoiceUsed(invoice: string): boolean {
    return this.rt.view<boolean>(VAULT, "is_invoice_used", {
      owner: OWNER,
      invoice_hash: hashInvoice(invoice),
    });
  }

  // ---------- Internals ----------

  private fromVault(match: (to: string) => boolean): bigint {
    return this.rt.movements
      .slice(this.movementsFrom)
      .filter((move) => move.from === VAULT && match(move.to))
      .reduce((total, move) => total + move.amount, 0n);
  }

  private note(tried: string, result: Omit<Attempt, "tried">): Attempt {
    const attempt = { tried, ...result };
    this.attempts.push(attempt);
    return attempt;
  }

  private checkerOutput(input: string): string | null {
    if (this.checkerOverride !== undefined) return this.checkerOverride;
    return this.runChecker(input, this.secretKey);
  }

  private outlayer(call: {
    method: string;
    args: Uint8Array;
    deposit: bigint;
    receiptId: number;
  }): { ok: true; value: Uint8Array } | { ok: false; error: string } | "hold" {
    const args = JSON.parse(textDecoder.decode(call.args)) as { input_data: string };
    if (call.method !== "request_execution" || call.deposit < BigInt(CHECKER_FEE)) {
      return { ok: false, error: "refused" };
    }
    if (this.holdChecker) {
      this.held.push({ receiptId: call.receiptId, input: args.input_data });
      return "hold";
    }
    // OutLayer's `Json` format returns the guest's JSON as is, and null for a failed run.
    const output = this.checkerOutput(args.input_data) ?? "null";
    return { ok: true, value: textEncoder.encode(output) };
  }

  private async requestPayment(args: PaymentArgs): Promise<VaultOutcome> {
    const handle = this.rt.send({
      signer: AGENT,
      key: "function-call",
      receiver: VAULT,
      action: { kind: "call", method: "request_payment", args },
    });
    const result = handle.result();
    if (result.pending) {
      return new Promise((resolve) => {
        this.waiters.push({ resolve, result: () => handle.result() });
      });
    }
    return this.toOutcome(result);
  }

  private toOutcome(result: TxResult): VaultOutcome {
    if (!result.outcome?.ok) {
      return {
        decision: "PANIC",
        reason: result.outcome?.error ?? "pending",
        mandateId: null,
        requestId: null,
        events: eventsOf(result.logs),
      };
    }
    const value = JSON.parse(textDecoder.decode(result.outcome.value)) as {
      decision: string;
      reason: string;
      mandate_id: string | null;
      request_id: string | null;
    };
    return {
      decision: value.decision,
      reason: value.reason,
      mandateId: value.mandate_id,
      requestId: value.request_id,
      events: eventsOf(result.logs),
    };
  }

  private tx(tx: Tx, tried: string): Attempt {
    const result = this.rt.send(tx).result();
    if (result.refused) {
      return this.note(tried, {
        layer: "key",
        decision: "REFUSED",
        reason: result.refused,
        checkerReasons: [],
      });
    }
    if (result.pending || !result.outcome) throw new Error(`${tried} did not finish`);
    if (!result.outcome.ok) {
      const isPrivate = /private/i.test(result.outcome.error);
      return this.note(tried, {
        layer: "contract",
        decision: "REFUSED",
        reason: isPrivate ? "METHOD_IS_PRIVATE" : "CALL_FAILED",
        checkerReasons: [],
      });
    }
    const paid = toPayResult(this.toOutcome(result));
    return this.note(tried, {
      layer: paid.layer,
      decision: paid.decision,
      reason: paid.reason,
      checkerReasons: paid.checkerReasons,
    });
  }

  /** Setup calls, which must succeed. */
  private call(
    signer: string,
    receiver: string,
    method: string,
    args: unknown,
    deposit = "0",
  ): Record<string, unknown> {
    const result = this.rt
      .send({ signer, receiver, action: { kind: "call", method, args, deposit: BigInt(deposit) } })
      .result();
    if (!result.outcome?.ok) {
      throw new Error(`setup ${method} failed: ${JSON.stringify(result.outcome)}`);
    }
    const text = textDecoder.decode(result.outcome.value);
    const value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (value.decision !== undefined && value.decision !== "OK") {
      throw new Error(`setup ${method} refused: ${text}`);
    }
    return value;
  }
}

function sum(moves: { amount: bigint }[]): bigint {
  return moves.reduce((total, move) => total + move.amount, 0n);
}

function publicKeyOf(secretKey: Uint8Array): string {
  const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  return createPublicKey(
    createPrivateKey({
      key: Buffer.concat([pkcs8Prefix, secretKey]),
      format: "der",
      type: "pkcs8",
    }),
  )
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
}

function toBigIntOrZero(amount: string): bigint {
  try {
    return BigInt(amount);
  } catch {
    return 0n;
  }
}

/** Keeps odd characters visible in the report instead of hiding the attack. */
function printable(text: string): string {
  const short = text.length > 40 ? `${text.slice(0, 37)}...` : text;
  return short.replace(/[^\x20-\x7e]/g, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}
