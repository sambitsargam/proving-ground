// Runs the attacks on a real NEAR node: a local sandbox with a mock OutLayer, or testnet
// with the real checker. Every key limit, callback and refusal here is the real thing.

import type { Near } from "near-kit";
import {
  type BlobStore,
  Guard,
  hashPurpose,
  type MandateTerms,
  newPurposeSalt,
  toPayResult,
  near as toYocto,
  type VaultClient,
  type VaultEvent,
} from "provingground-guard";
import { outcomeFromChain } from "provingground-guard/near";
import type { Attempt, MandateOverrides, Pay, World } from "./attack.ts";
import { CheckerLogic } from "./checker.ts";
import type { ModelMode } from "./model.ts";
import {
  CHECKER_BUDGET,
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
import { printable } from "./world.ts";

const GAS = "300 Tgas";
/** Covers storage for MAX_REQUESTS and the mandate record. The rest becomes its balance. */
const STORAGE_MARGIN = BigInt(toYocto("0.14"));
const OPTIMISTIC = { finality: "optimistic" } as const;
const SETTLE_TIMEOUT_MS = 60_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface MandateView {
  balance: string;
  spent: string;
  reserved: string;
  checker_budget: string;
  storage_balance: string;
  requests_stored: number;
}

/** A mock OutLayer's jobs, answered by the real checker logic and a stand-in model. */
export class SandboxChecker {
  readonly logic: CheckerLogic;
  hold = false;
  private readonly near: Near;
  private readonly outlayerId: string;
  private readonly signerId: string;
  private seen = 0;
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(options: {
    near: Near;
    outlayerId: string;
    signerId: string;
    blobs: Map<string, string>;
    secretKey: Uint8Array;
  }) {
    this.near = options.near;
    this.outlayerId = options.outlayerId;
    this.signerId = options.signerId;
    this.logic = new CheckerLogic(options.blobs, options.secretKey);
  }

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const count = await this.near.view<number>(this.outlayerId, "request_count", {}, OPTIMISTIC);
      while (!this.hold && this.seen < (count ?? 0)) {
        this.seen += 1;
        await this.answer(this.seen);
      }
      await sleep(POLL_MS / 2);
    }
  }

  private async answer(requestId: number): Promise<void> {
    const call = await this.near.view<{ input_data: string }>(
      this.outlayerId,
      "get_call",
      { request_id: requestId },
      OPTIMISTIC,
    );
    if (!call) throw new Error(`mock OutLayer has no call ${requestId}`);
    await this.near
      .transaction(this.signerId)
      .functionCall(
        this.outlayerId,
        "resolve",
        { request_id: requestId, output: this.logic.output(call.input_data) },
        { gas: GAS },
      )
      .send();
  }
}

export interface ChainSetup {
  /** Signs for the owner and the attacker. */
  near: Near;
  /** Holds only the agent's function call key. */
  agentNear: Near;
  rpcUrl: string;
  vault: string;
  owner: string;
  agent: string;
  vendor: string;
  attacker: string;
  payroll: string;
  /** Sends the agent's payments, signed with its function call key. */
  vaultClient: VaultClient;
  blobs: BlobStore;
  checkerPublicKey: string;
  /** Present when the checker can be told to misbehave. Real OutLayer cannot. */
  control?: SandboxChecker;
  /** Makes invoice hashes new each run, since real chains remember the last run's. */
  runId: string;
  /** Takes each mandate's funds back afterwards. Worth doing with faucet NEAR. */
  recover: boolean;
  /** How long a mandate lasts when the attack needs an expired one. */
  expiryMs: number;
}

async function nativeBalance(rpcUrl: string, accountId: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "view_account",
        finality: "optimistic",
        account_id: accountId,
      },
    }),
  });
  const body = (await response.json()) as { result?: { amount?: string } };
  if (body.result?.amount === undefined) throw new Error(`no account ${accountId}`);
  return BigInt(body.result.amount);
}

/** What the network says when an access key is used beyond its limits. */
function keyRefusal(error: unknown): string | undefined {
  const text = `${error instanceof Error ? error.message : ""} ${JSON.stringify(error)}`;
  if (/RequiresFullAccess/.test(text)) return "KEY_ACTION_NOT_ALLOWED";
  if (/DepositWithFunctionCall/.test(text)) return "KEY_DEPOSIT_NOT_ALLOWED";
  if (/MethodNameMismatch|ReceiverMismatch/.test(text)) return "KEY_METHOD_NOT_ALLOWED";
  return undefined;
}

export class ChainWorld implements World {
  readonly vendor: string;
  readonly attacker: string;
  readonly payroll: string;
  readonly attempts: Attempt[] = [];
  mandateId = "";

  private readonly setup: ChainSetup;
  private readonly guard: Guard;
  private readonly terms: Record<string, MandateTerms> = {};
  private readonly mandateIds: string[] = [];
  private readonly listed = new Set<string>();
  private attackerStart = 0n;
  private settled: { payee: string; amount: bigint }[] = [];
  private paidFrom = 0;
  private requestsSeen = 0;

  private constructor(setup: ChainSetup) {
    this.setup = setup;
    this.vendor = setup.vendor;
    this.attacker = setup.attacker;
    this.payroll = setup.payroll;
    this.guard = new Guard({
      vault: setup.vaultClient,
      blobs: setup.blobs,
      checkerPublicKey: setup.checkerPublicKey,
      mandates: this.terms,
    });
  }

  /** A fresh mandate and a full daily allowance, on a vault that outlives the attack. */
  static async create(setup: ChainSetup): Promise<ChainWorld> {
    const world = new ChainWorld(setup);
    if (setup.control) {
      setup.control.hold = false;
      setup.control.logic.modelMode = "honest";
      setup.control.logic.override = undefined;
    }
    const { near, owner, vault, agent, rpcUrl, attacker } = setup;
    const status = await near.view<{ used_today: string }>(
      vault,
      "get_daily_status",
      { owner, agent, token: null },
      OPTIMISTIC,
    );
    const cap = BigInt(status?.used_today ?? "0") + BigInt(DAILY_CAP);
    await near
      .transaction(owner)
      .functionCall(
        vault,
        "set_daily_cap",
        { agent, token: null, cap: cap.toString() },
        { gas: "30 Tgas", attachedDeposit: "0.1 NEAR" },
      )
      .send();
    world.mandateId = await world.createMandate();
    world.attackerStart = await nativeBalance(rpcUrl, attacker);
    return world;
  }

  get holdChecker(): boolean {
    return this.setup.control?.hold ?? false;
  }

  set holdChecker(hold: boolean) {
    if (this.setup.control) this.setup.control.hold = hold;
  }

  get modelMode(): ModelMode {
    return this.setup.control?.logic.modelMode ?? "honest";
  }

  set modelMode(mode: ModelMode) {
    if (!this.setup.control) throw new Error("the real checker cannot be told how to behave");
    this.setup.control.logic.modelMode = mode;
  }

  get checkerOverride(): ((requestId: string) => string | null) | undefined {
    return this.setup.control?.logic.override;
  }

  set checkerOverride(override: ((requestId: string) => string | null) | undefined) {
    if (!this.setup.control) throw new Error("the real checker cannot be told how to behave");
    this.setup.control.logic.override = override;
  }

  async createMandate(
    overrides: MandateOverrides = {},
    lifetimeNs = 30n * DAY_NS,
  ): Promise<string> {
    const { near, owner, vault, agent } = this.setup;
    const purpose = overrides.purpose ?? PURPOSE;
    const purposeSalt = newPurposeSalt();
    const payees = overrides.payees ?? [this.vendor];
    const now = BigInt(Date.now()) * 1_000_000n;
    const deposit = BigInt(overrides.funding ?? FUNDING) + BigInt(CHECKER_BUDGET) + STORAGE_MARGIN;
    const outcome = await near
      .transaction(owner)
      .functionCall(
        vault,
        "create_mandate",
        {
          args: {
            agent,
            payees,
            token: null,
            max_total: overrides.maxTotal ?? MAX_TOTAL,
            max_per_payment: overrides.maxPerPayment ?? MAX_PER_PAYMENT,
            purpose_hash: hashPurpose(purpose, purposeSalt),
            expires_at: (now + lifetimeNs).toString(),
            max_requests: MAX_REQUESTS,
            max_checks_per_day: MAX_CHECKS_PER_DAY,
            park_ttl: DAY_NS.toString(),
            checker_budget: CHECKER_BUDGET,
          },
        },
        { gas: "100 Tgas", attachedDeposit: deposit },
      )
      .send();
    const decided = outcomeFromChain(outcome);
    if (decided?.decision !== "OK" || !decided.mandateId) {
      throw new Error(`create_mandate refused: ${JSON.stringify(decided)}`);
    }
    this.terms[decided.mandateId] = { purpose, purposeSalt };
    this.mandateIds.push(decided.mandateId);
    for (const payee of payees) this.listed.add(payee);
    return decided.mandateId;
  }

  createPayrollMandate(): Promise<string> {
    return this.createMandate({ payees: [this.payroll], purpose: PAYROLL_PURPOSE });
  }

  async pay(pay: Pay): Promise<Attempt> {
    const result = await this.guard.pay({
      mandateId: pay.mandateId ?? this.mandateId,
      payee: pay.payee,
      amount: pay.amount,
      // The same text gives the same hash within a run, so replays stay replays.
      invoice: `${pay.invoice}\nRun: ${this.setup.runId}`,
      ...(pay.memo === undefined ? {} : { memo: pay.memo }),
    });
    this.recordSettled(result.events);
    return this.note(`request_payment to ${printable(pay.payee)}`, {
      layer: result.layer,
      decision: result.decision,
      reason: result.reason,
      checkerReasons: result.checkerReasons,
      ...(result.txHash ? { txHash: result.txHash } : {}),
    });
  }

  /** Waits for a request sent without awaiting to show up on-chain. */
  async settle(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const total = await this.requestsStored();
      if (total > this.requestsSeen) {
        this.requestsSeen = total;
        return;
      }
      await sleep(POLL_MS);
    }
    throw new Error("the request never reached the vault");
  }

  agentCall(method: string, args: unknown, deposit = "0"): Promise<Attempt> {
    const { agentNear, agent, vault } = this.setup;
    return this.call(agentNear, agent, vault, method, args, deposit, `agent key calls ${method}`);
  }

  async agentTransfer(to: string, amount: string): Promise<Attempt> {
    const { agentNear, agent } = this.setup;
    return this.attempt(`agent key transfers to ${to}`, () =>
      agentNear.transaction(agent).transfer(to, BigInt(amount)).send(),
    );
  }

  attackerCall(method: string, args: unknown, deposit = "0"): Promise<Attempt> {
    const { near, attacker, vault } = this.setup;
    return this.call(near, attacker, vault, method, args, deposit, `attacker calls ${method}`);
  }

  ownerCall(method: string, args: unknown, deposit = "1"): Promise<Attempt> {
    const { near, owner, vault } = this.setup;
    return this.call(near, owner, vault, method, args, deposit, `owner calls ${method}`);
  }

  /** A real chain's clock cannot be moved, so this makes a mandate that ends very soon. */
  async expireMandates(): Promise<void> {
    const { expiryMs } = this.setup;
    this.mandateId = await this.createMandate({}, BigInt(expiryMs) * 1_000_000n);
    await sleep(expiryMs + 1_500);
  }

  async releaseChecker(): Promise<void> {
    this.holdChecker = false;
  }

  async markClean(): Promise<void> {
    this.paidFrom = this.settled.length;
  }

  async fundsLost(): Promise<bigint> {
    const toUnlisted = this.settled
      .filter((payment) => !this.listed.has(payment.payee))
      .reduce((total, payment) => total + payment.amount, 0n);
    // The attacker pays gas on their own calls, so any rise at all came from somewhere.
    const gain = (await nativeBalance(this.setup.rpcUrl, this.attacker)) - this.attackerStart;
    // biome-ignore lint/complexity/useMathMinMax: Math.max does not take bigints.
    return gain > toUnlisted ? gain : toUnlisted;
  }

  async paidToListed(): Promise<bigint> {
    return this.settled
      .slice(this.paidFrom)
      .filter((payment) => this.listed.has(payment.payee))
      .reduce((total, payment) => total + payment.amount, 0n);
  }

  /** An upper bound: on testnet, OutLayer refunds the unused part to the owner. */
  async feesBurned(): Promise<bigint> {
    let burned = 0n;
    for (const mandate of await this.mandates()) {
      burned += BigInt(CHECKER_BUDGET) - BigInt(mandate.checker_budget);
    }
    return burned;
  }

  async solvent(): Promise<boolean> {
    let held = 0n;
    for (const mandate of await this.mandates()) {
      held +=
        BigInt(mandate.balance) + BigInt(mandate.checker_budget) + BigInt(mandate.storage_balance);
    }
    return (await nativeBalance(this.setup.rpcUrl, this.setup.vault)) >= held;
  }

  lastAttempt(): Attempt | undefined {
    return this.attempts.at(-1);
  }

  async finish(): Promise<void> {
    if (!this.setup.recover) return;
    const { near, owner, vault } = this.setup;
    const send = (method: string, args: object) =>
      near
        .transaction(owner)
        .functionCall(vault, method, args, { gas: "100 Tgas", attachedDeposit: "1 yocto" })
        .send();
    for (const id of this.mandateIds) {
      try {
        const requests = await near.view<{ id: string; status: string }[]>(
          vault,
          "list_requests",
          { mandate_id: id, from_index: 0, limit: 100 },
          OPTIMISTIC,
        );
        for (const request of requests ?? []) {
          if (request.status === "Parked") await send("reject", { request_id: request.id });
        }
        const mandate = await near.view<MandateView>(
          vault,
          "get_mandate",
          { mandate_id: id },
          OPTIMISTIC,
        );
        if (mandate && BigInt(mandate.balance) > 0n) {
          await send("withdraw", { mandate_id: id, amount: mandate.balance });
        }
        await send("close", { mandate_id: id });
      } catch (error) {
        process.stderr.write(`could not recover mandate ${id}: ${String(error)}\n`);
      }
    }
  }

  private async mandates(): Promise<MandateView[]> {
    const { near, vault } = this.setup;
    const views = await Promise.all(
      this.mandateIds.map((id) =>
        near.view<MandateView>(vault, "get_mandate", { mandate_id: id }, OPTIMISTIC),
      ),
    );
    return views.filter((view): view is MandateView => view !== undefined && view !== null);
  }

  private async requestsStored(): Promise<number> {
    return (await this.mandates()).reduce((total, m) => total + m.requests_stored, 0);
  }

  private recordSettled(events: VaultEvent[]): void {
    for (const { event, data } of events) {
      if (event === "payment_settled" && data.success === true) {
        this.settled.push({ payee: String(data.payee), amount: BigInt(String(data.amount)) });
      }
    }
  }

  private note(tried: string, result: Omit<Attempt, "tried">): Attempt {
    const attempt = { tried, ...result };
    this.attempts.push(attempt);
    return attempt;
  }

  private call(
    near: Near,
    signer: string,
    receiver: string,
    method: string,
    args: unknown,
    deposit: string,
    tried: string,
  ): Promise<Attempt> {
    return this.attempt(tried, () =>
      near
        .transaction(signer)
        .functionCall(receiver, method, args as object, {
          gas: GAS,
          ...(deposit === "0" ? {} : { attachedDeposit: BigInt(deposit) }),
        })
        .send(),
    );
  }

  private async attempt(tried: string, send: () => Promise<unknown>): Promise<Attempt> {
    let sent: unknown;
    try {
      sent = await send();
    } catch (error) {
      const refused = keyRefusal(error);
      if (refused) {
        return this.note(tried, {
          layer: "key",
          decision: "REFUSED",
          reason: refused,
          checkerReasons: [],
        });
      }
      const text = error instanceof Error ? error.message : String(error);
      return this.note(tried, {
        layer: "contract",
        decision: "REFUSED",
        reason: /private/i.test(text) ? "METHOD_IS_PRIVATE" : "CALL_FAILED",
        checkerReasons: [],
      });
    }
    const outcome = outcomeFromChain(sent as Parameters<typeof outcomeFromChain>[0]);
    if (!outcome) throw new Error(`${tried} did not finish`);
    const result = toPayResult(outcome);
    this.recordSettled(result.events);
    return this.note(tried, {
      layer: result.layer,
      decision: result.decision,
      reason: result.reason,
      checkerReasons: result.checkerReasons,
      ...(result.txHash ? { txHash: result.txHash } : {}),
    });
  }
}
