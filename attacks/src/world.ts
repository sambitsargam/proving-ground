import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Guard,
  hashInvoice,
  hashPurpose,
  type MandateTerms,
  MemoryBlobStore,
  near,
  type PaymentArgs,
  sha256Hex,
  toPayResult,
  type VaultEvent,
  type VaultOutcome,
} from "provingground-guard";
import type { Attempt, MandateOverrides, Pay, World } from "./attack.ts";
import { CheckerLogic, wasmDir } from "./checker.ts";
import type { ModelMode } from "./model.ts";
import { NearRuntime, type Tx, type TxResult } from "./runtime.ts";
import {
  CHECK_TIMEOUT_NS,
  CHECKER_BUDGET,
  CHECKER_FEE,
  DAILY_CAP,
  DAY_NS,
  FUNDING,
  MAX_CHECKS_PER_DAY,
  MAX_PER_PAYMENT,
  MAX_REQUESTS,
  MAX_TOTAL,
  PAYROLL_PURPOSE,
  PURPOSE,
} from "./terms.ts";

export type { Attempt, MandateOverrides, Pay } from "./attack.ts";

export const VAULT = "vault.testnet";
export const OWNER = "treasury.testnet";
export const AGENT = "agent.testnet";
export const VENDOR = "acmehosting.testnet";
export const PAYROLL = "payroll.testnet";
export const ATTACKER = "attacker.testnet";
const OUTLAYER = "outlayer.testnet";

/** More than storage and the checker budget need. `createMandate` returns the surplus. */
const CREATE_DEPOSIT = near("1");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const load = (name: string) => readFileSync(new URL(name, wasmDir));

export function wasmHashes(): { vault: string; checker: string } {
  return { vault: sha256Hex(load("vault.wasm")), checker: sha256Hex(load("checker.wasm")) };
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

/** Keeps odd characters visible in the report instead of hiding the attack. */
export function printable(text: string): string {
  const short = text.length > 40 ? `${text.slice(0, 37)}...` : text;
  return short.replace(/[^\x20-\x7e]/g, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}

/**
 * One fresh deployment for one attack: the real vault WASM on the simulated runtime, the
 * real checker logic behind a stand-in model, and an agent holding only a function call key.
 */
export class MockWorld implements World {
  readonly rt = new NearRuntime();
  readonly attempts: Attempt[] = [];
  readonly vendor = VENDOR;
  readonly attacker = ATTACKER;
  readonly payroll = PAYROLL;
  /** Mandate the agent works under. */
  readonly mandateId: string;
  holdChecker = false;
  readonly guard: Guard;

  private readonly blobs = new MemoryBlobStore();
  private readonly secretKey = randomBytes(32);
  private readonly terms: Record<string, MandateTerms> = {};
  private readonly checker: CheckerLogic;
  private readonly held: { receiptId: number; input: string }[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly listedPayees = new Set<string>();
  private readonly mandateIds: string[] = [];
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
        check_timeout_ns: CHECK_TIMEOUT_NS.toString(),
      },
    });
    rt.removeFullAccessKeys(VAULT);

    rt.addKey(AGENT, "function-call", {
      kind: "function_call",
      receiver: VAULT,
      methods: ["request_payment"],
    });
    rt.removeFullAccessKeys(AGENT);

    this.checker = new CheckerLogic(this.blobs.blobs, this.secretKey);
    this.call(
      OWNER,
      VAULT,
      "set_daily_cap",
      { agent: AGENT, token: null, cap: DAILY_CAP },
      near("0.1"),
    );
    this.mandateId = this.createMandateNow();
    this.guard = new Guard({
      vault: { requestPayment: (args) => this.requestPayment(args) },
      blobs: this.blobs,
      checkerPublicKey: publicKeyOf(this.secretKey),
      mandates: this.terms,
    });
    this.movementsFrom = this.rt.movements.length;
  }

  get modelMode(): ModelMode {
    return this.checker.modelMode;
  }

  set modelMode(mode: ModelMode) {
    this.checker.modelMode = mode;
  }

  get checkerOverride(): ((requestId: string) => string | null) | undefined {
    return this.checker.override;
  }

  set checkerOverride(override: ((requestId: string) => string | null) | undefined) {
    this.checker.override = override;
  }

  async createMandate(overrides: MandateOverrides = {}): Promise<string> {
    return this.createMandateNow(overrides);
  }

  async createPayrollMandate(): Promise<string> {
    return this.createMandateNow({ payees: [PAYROLL], purpose: PAYROLL_PURPOSE });
  }

  async pay(pay: Pay): Promise<Attempt> {
    const result = await this.guard.pay({
      mandateId: pay.mandateId ?? this.mandateId,
      payee: pay.payee,
      amount: pay.amount,
      invoice: pay.invoice,
      ...(pay.memo === undefined ? {} : { memo: pay.memo }),
    });
    return this.note(`request_payment to ${printable(pay.payee)}`, {
      layer: result.layer,
      decision: result.decision,
      reason: result.reason,
      checkerReasons: result.checkerReasons,
    });
  }

  async settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  async agentCall(method: string, args: unknown, deposit = "0"): Promise<Attempt> {
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

  async agentTransfer(to: string, amount: string): Promise<Attempt> {
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

  async attackerCall(method: string, args: unknown, deposit = "0"): Promise<Attempt> {
    return this.tx(
      {
        signer: ATTACKER,
        receiver: VAULT,
        action: { kind: "call", method, args, deposit: BigInt(deposit) },
      },
      `attacker calls ${method}`,
    );
  }

  async ownerCall(method: string, args: unknown, deposit = "1"): Promise<Attempt> {
    return this.tx(
      {
        signer: OWNER,
        receiver: VAULT,
        action: { kind: "call", method, args, deposit: BigInt(deposit) },
      },
      `owner calls ${method}`,
    );
  }

  async expireMandates(): Promise<void> {
    this.rt.advance(31n * DAY_NS);
  }

  async releaseChecker(): Promise<void> {
    this.holdChecker = false;
    for (const { receiptId, input } of this.held.splice(0)) {
      const output = this.checker.output(input);
      this.rt.resolveHeld(receiptId, textEncoder.encode(output ?? "null"));
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(this.toOutcome(waiter.result()));
    }
    await this.settle();
  }

  async markClean(): Promise<void> {
    this.movementsFrom = this.rt.movements.length;
  }

  async fundsLost(): Promise<bigint> {
    const moves = this.rt.movements.slice(this.movementsFrom);
    let lost = this.attackerGain();
    for (const account of new Set(moves.map((move) => move.to))) {
      if ([VAULT, OWNER, OUTLAYER, ATTACKER].includes(account)) continue;
      if (this.listedPayees.has(account)) continue;
      const out = moves.filter((m) => m.from === VAULT && m.to === account);
      const back = moves.filter((m) => m.from === account && m.to === VAULT);
      const net = sum(out) - sum(back);
      if (net > 0n) lost += net;
    }
    return lost;
  }

  async paidToListed(): Promise<bigint> {
    return this.fromVault((to) => this.listedPayees.has(to));
  }

  async feesBurned(): Promise<bigint> {
    return this.fromVault((to) => to === OUTLAYER);
  }

  attackerGain(): bigint {
    return this.rt.balance(ATTACKER) - BigInt(near("1"));
  }

  async solvent(): Promise<boolean> {
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

  lastAttempt(): Attempt | undefined {
    return this.attempts.at(-1);
  }

  async finish(): Promise<void> {}

  invoiceUsed(invoice: string): boolean {
    return this.rt.view<boolean>(VAULT, "is_invoice_used", {
      owner: OWNER,
      invoice_hash: hashInvoice(invoice),
    });
  }

  private createMandateNow(overrides: MandateOverrides = {}): string {
    const purpose = overrides.purpose ?? PURPOSE;
    const purposeSalt = randomBytes(16).toString("hex");
    const payees = overrides.payees ?? [VENDOR];
    const result = this.call(
      OWNER,
      VAULT,
      "create_mandate",
      {
        args: {
          agent: AGENT,
          payees,
          token: null,
          max_total: overrides.maxTotal ?? MAX_TOTAL,
          max_per_payment: overrides.maxPerPayment ?? MAX_PER_PAYMENT,
          purpose_hash: hashPurpose(purpose, purposeSalt),
          expires_at: (this.rt.now + 30n * DAY_NS).toString(),
          max_requests: MAX_REQUESTS,
          max_checks_per_day: MAX_CHECKS_PER_DAY,
          park_ttl: DAY_NS.toString(),
          checker_budget: CHECKER_BUDGET,
        },
      },
      CREATE_DEPOSIT,
    );
    const id = result.mandate_id as string;
    this.terms[id] = { purpose, purposeSalt };
    this.mandateIds.push(id);
    for (const payee of payees) this.listedPayees.add(payee);

    const { balance } = this.rt.view<{ balance: string }>(VAULT, "get_mandate", { mandate_id: id });
    if (BigInt(balance) > 0n) {
      this.call(OWNER, VAULT, "withdraw", { mandate_id: id, amount: balance }, "1");
    }
    this.call(OWNER, VAULT, "fund", { mandate_id: id }, overrides.funding ?? FUNDING);
    return id;
  }

  private fromVault(match: (to: string) => boolean): bigint {
    return sum(
      this.rt.movements
        .slice(this.movementsFrom)
        .filter((move) => move.from === VAULT && match(move.to)),
    );
  }

  private note(tried: string, result: Omit<Attempt, "tried">): Attempt {
    const attempt = { tried, ...result };
    this.attempts.push(attempt);
    return attempt;
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
    const output = this.checker.output(args.input_data) ?? "null";
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
