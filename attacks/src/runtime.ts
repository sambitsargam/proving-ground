// A small NEAR runtime for mock mode. It runs the real compiled vault contract with
// no network and no keys, so mock results come from the same code that gets deployed.
//
// It models what the attacks depend on: receipts and promise chains, private callbacks,
// balances, rollback on panic and access key limits. It does not model gas costs or
// storage staking. Sandbox tests in contracts/vault-tests cover those on a real node.

import { createHash } from "node:crypto";

export type AccessKey =
  | { kind: "full" }
  | { kind: "function_call"; receiver: string; methods: string[] };

type Action =
  | { kind: "transfer"; amount: bigint }
  | { kind: "call"; method: string; args: Uint8Array; deposit: bigint; gas: bigint }
  | { kind: "add_key" };

type Outcome = { ok: true; value: Uint8Array } | { ok: false; error: string };

/** A contract written in TypeScript, for services the vault calls such as OutLayer. */
export type NativeContract = (call: {
  method: string;
  args: Uint8Array;
  deposit: bigint;
  predecessor: string;
  receiptId: number;
}) => Outcome | "hold";

interface Account {
  balance: bigint;
  storage: Map<string, Uint8Array>;
  module?: WebAssembly.Module;
  native?: NativeContract;
  keys: Map<string, AccessKey>;
}

interface Receipt {
  id: number;
  root: number;
  predecessor: string;
  receiver: string;
  actions: Action[];
  deps: number[];
  state: "waiting" | "held" | "forwarded" | "done";
  forwardTo?: number;
  outcome?: Outcome;
}

export interface Movement {
  from: string;
  to: string;
  amount: bigint;
}

export type KeyRefusal =
  | "KEY_METHOD_NOT_ALLOWED"
  | "KEY_ACTION_NOT_ALLOWED"
  | "KEY_DEPOSIT_NOT_ALLOWED";

export interface TxResult {
  /** Why the network rejected the transaction before it ran. */
  refused?: KeyRefusal;
  /** Still waiting on a held service call. */
  pending: boolean;
  outcome?: Outcome;
  logs: string[];
}

export interface Tx {
  signer: string;
  /** Name of the signer's key. Defaults to its full-access key. */
  key?: string;
  receiver: string;
  action:
    | { kind: "call"; method: string; args: unknown; deposit?: bigint; gas?: bigint }
    | { kind: "transfer"; amount: bigint }
    | { kind: "add_key" };
}

export const MAX_GAS = 300_000_000_000_000n;
const TX_DEFAULT_GAS = MAX_GAS;
const REGISTER_ABSENT = 0xffff_ffff_ffff_ffffn;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class GuestPanic extends Error {}

/** Pending promises made during one function call. Indexes are local until it succeeds. */
interface LocalPromise {
  receiver: string;
  actions: Action[];
  deps: number[];
}

export class NearRuntime {
  now = 1_800_000_000_000_000_000n;
  /** Every transfer of value that actually happened, in order. */
  readonly movements: Movement[] = [];
  private readonly accounts = new Map<string, Account>();
  private readonly receipts = new Map<number, Receipt>();
  private readonly logsByRoot = new Map<number, string[]>();
  private nextReceipt = 1;

  createAccount(id: string, balance: bigint): void {
    this.accounts.set(id, {
      balance,
      storage: new Map(),
      keys: new Map([["default", { kind: "full" }]]),
    });
  }

  addKey(id: string, name: string, key: AccessKey): void {
    this.account(id).keys.set(name, key);
  }

  removeFullAccessKeys(id: string): void {
    for (const [name, key] of this.account(id).keys) {
      if (key.kind === "full") this.account(id).keys.delete(name);
    }
  }

  keys(id: string): AccessKey[] {
    return [...this.account(id).keys.values()];
  }

  deploy(id: string, wasm: Uint8Array): void {
    this.account(id).module = new WebAssembly.Module(wasm as Uint8Array<ArrayBuffer>);
  }

  deployNative(id: string, contract: NativeContract): void {
    this.account(id).native = contract;
  }

  balance(id: string): bigint {
    return this.accounts.get(id)?.balance ?? 0n;
  }

  advance(ns: bigint): void {
    this.now += ns;
  }

  /** Signs and sends a transaction, then runs every receipt that can run. */
  send(tx: Tx): TxHandle {
    const signer = this.account(tx.signer);
    const key = signer.keys.get(tx.key ?? "default");
    if (!key) throw new Error(`${tx.signer} has no key ${tx.key}`);

    let action: Action;
    if (tx.action.kind === "call") {
      action = {
        kind: "call",
        method: tx.action.method,
        args: encoder.encode(JSON.stringify(tx.action.args ?? {})),
        deposit: tx.action.deposit ?? 0n,
        gas: tx.action.gas ?? TX_DEFAULT_GAS,
      };
    } else {
      action = tx.action;
    }

    const refused = refusal(key, tx.receiver, action);
    if (refused) return new TxHandle(this, 0, refused);

    const deposit = attachedValue(action);
    if (signer.balance < deposit) throw new Error(`${tx.signer} cannot cover the deposit`);
    signer.balance -= deposit;

    const id = this.nextReceipt++;
    this.logsByRoot.set(id, []);
    this.receipts.set(id, {
      id,
      root: id,
      predecessor: tx.signer,
      receiver: tx.receiver,
      actions: [action],
      deps: [],
      state: "waiting",
    });
    this.pump();
    return new TxHandle(this, id);
  }

  /** A read-only call. */
  view<T>(contract: string, method: string, args: unknown = {}): T {
    const account = this.account(contract);
    const before = new Map(account.storage);
    const result = this.runWasm(account, contract, {
      predecessor: contract,
      method,
      args: encoder.encode(JSON.stringify(args)),
      deposit: 0n,
      gas: MAX_GAS,
      results: [],
      logs: [],
    });
    account.storage = before;
    if (!result.outcome.ok) throw new Error(`view ${method} failed: ${result.outcome.error}`);
    return JSON.parse(decoder.decode(result.outcome.value)) as T;
  }

  /** Completes a call a native contract held, as OutLayer does after running a job. */
  resolveHeld(receiptId: number, value: Uint8Array | null): void {
    const receipt = this.receipts.get(receiptId);
    if (receipt?.state !== "held") throw new Error(`receipt ${receiptId} is not held`);
    receipt.state = "done";
    receipt.outcome = value ? { ok: true, value } : { ok: false, error: "execution failed" };
    this.pump();
  }

  resultOf(id: number): TxResult {
    const final = this.settled(id);
    return {
      pending: !final,
      ...(final ? { outcome: final } : {}),
      logs: this.logsByRoot.get(this.receipts.get(id)?.root ?? id) ?? [],
    };
  }

  private account(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`no account ${id}`);
    return account;
  }

  /** Follows promise_return chains to the value a receipt finally resolved to. */
  private settled(id: number): Outcome | undefined {
    const receipt = this.receipts.get(id);
    if (!receipt) return undefined;
    if (receipt.state === "forwarded" && receipt.forwardTo !== undefined) {
      return this.settled(receipt.forwardTo);
    }
    return receipt.state === "done" ? receipt.outcome : undefined;
  }

  private pump(): void {
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (const receipt of this.receipts.values()) {
        if (receipt.state !== "waiting") continue;
        if (!receipt.deps.every((dep) => this.settled(dep))) continue;
        this.execute(receipt);
        progressed = true;
      }
    }
  }

  private refund(to: string, amount: bigint): void {
    const account = this.accounts.get(to);
    if (account && amount > 0n) account.balance += amount;
  }

  private execute(receipt: Receipt): void {
    let outcome: Outcome = { ok: true, value: new Uint8Array() };
    for (const action of receipt.actions) {
      if (action.kind === "transfer") {
        const target = this.accounts.get(receipt.receiver);
        if (!target) {
          this.refund(receipt.predecessor, action.amount);
          outcome = { ok: false, error: `${receipt.receiver} does not exist` };
          break;
        }
        target.balance += action.amount;
        this.movements.push({
          from: receipt.predecessor,
          to: receipt.receiver,
          amount: action.amount,
        });
      } else if (action.kind === "call") {
        const result = this.executeCall(receipt, action);
        if (result === "held" || result === "forwarded") return;
        outcome = result;
        if (!outcome.ok) break;
      }
    }
    receipt.state = "done";
    receipt.outcome = outcome;
  }

  private executeCall(
    receipt: Receipt,
    action: Extract<Action, { kind: "call" }>,
  ): Outcome | "held" | "forwarded" {
    const account = this.accounts.get(receipt.receiver);
    if (!account) {
      this.refund(receipt.predecessor, action.deposit);
      return { ok: false, error: `${receipt.receiver} does not exist` };
    }
    if (account.native) {
      const result = account.native({
        method: action.method,
        args: action.args,
        deposit: action.deposit,
        predecessor: receipt.predecessor,
        receiptId: receipt.id,
      });
      if (result === "hold") {
        account.balance += action.deposit;
        this.recordDeposit(receipt, action.deposit);
        receipt.state = "held";
        return "held";
      }
      if (result.ok) {
        account.balance += action.deposit;
        this.recordDeposit(receipt, action.deposit);
      } else {
        this.refund(receipt.predecessor, action.deposit);
      }
      return result;
    }
    if (!account.module) {
      this.refund(receipt.predecessor, action.deposit);
      return { ok: false, error: `${receipt.receiver} has no contract` };
    }

    const storage = new Map(account.storage);
    const balance = account.balance;
    account.balance += action.deposit;
    const logs = this.logsByRoot.get(receipt.root) ?? [];
    const { outcome, promises, returned } = this.runWasm(account, receipt.receiver, {
      predecessor: receipt.predecessor,
      method: action.method,
      args: action.args,
      deposit: action.deposit,
      gas: action.gas,
      results: receipt.deps.map((dep) => this.settled(dep) as Outcome),
      logs,
    });
    if (!outcome.ok) {
      account.storage = storage;
      account.balance = balance;
      this.refund(receipt.predecessor, action.deposit);
      return outcome;
    }
    this.recordDeposit(receipt, action.deposit);

    const ids = promises.map(() => this.nextReceipt++);
    promises.forEach((promise, index) => {
      const id = ids[index] as number;
      this.receipts.set(id, {
        id,
        root: receipt.root,
        predecessor: receipt.receiver,
        receiver: promise.receiver,
        actions: promise.actions,
        deps: promise.deps.map((dep) => ids[dep] as number),
        state: "waiting",
      });
    });
    if (returned !== undefined) {
      receipt.state = "forwarded";
      receipt.forwardTo = ids[returned] as number;
      return "forwarded";
    }
    return outcome;
  }

  private recordDeposit(receipt: Receipt, deposit: bigint): void {
    if (deposit > 0n) {
      this.movements.push({ from: receipt.predecessor, to: receipt.receiver, amount: deposit });
    }
  }

  private runWasm(
    account: Account,
    self: string,
    call: {
      predecessor: string;
      method: string;
      args: Uint8Array;
      deposit: bigint;
      gas: bigint;
      results: Outcome[];
      logs: string[];
    },
  ): { outcome: Outcome; promises: LocalPromise[]; returned?: number } {
    if (!account.module) return { outcome: { ok: false, error: "no contract" }, promises: [] };

    const registers = new Map<bigint, Uint8Array>();
    const promises: LocalPromise[] = [];
    const logs: string[] = [];
    let returned: number | undefined;
    let value: Uint8Array = new Uint8Array();
    let memory: WebAssembly.Memory | undefined;

    const mem = () => new Uint8Array((memory as WebAssembly.Memory).buffer);
    const read = (ptr: bigint, len: bigint) => mem().slice(Number(ptr), Number(ptr) + Number(len));
    const text = (ptr: bigint, len: bigint) => decoder.decode(read(ptr, len));
    const key = (ptr: bigint, len: bigint) => Buffer.from(read(ptr, len)).toString("latin1");
    const u128 = (ptr: bigint) => {
      const bytes = read(ptr, 16n);
      let total = 0n;
      for (let i = 15; i >= 0; i--) total = (total << 8n) | BigInt(bytes[i] as number);
      return total;
    };
    const promise = (index: bigint) => {
      const found = promises[Number(index)];
      if (!found) throw new GuestPanic("bad promise index");
      return found;
    };
    const spend = (amount: bigint) => {
      if (account.balance < amount) throw new GuestPanic("balance exceeded");
      account.balance -= amount;
    };
    const addCall = (
      index: bigint,
      methodLen: bigint,
      methodPtr: bigint,
      argsLen: bigint,
      argsPtr: bigint,
      amountPtr: bigint,
      gas: bigint,
    ) => {
      const deposit = u128(amountPtr);
      spend(deposit);
      promise(index).actions.push({
        kind: "call",
        method: text(methodPtr, methodLen),
        args: read(argsPtr, argsLen),
        deposit,
        gas,
      });
    };
    const unsupported = (name: string) => () => {
      throw new GuestPanic(`host function not modelled: ${name}`);
    };

    const host: Record<string, unknown> = {
      read_register: (id: bigint, ptr: bigint) => {
        const data = registers.get(id);
        if (!data) throw new GuestPanic("register is empty");
        mem().set(data, Number(ptr));
      },
      register_len: (id: bigint) => BigInt(registers.get(id)?.length ?? REGISTER_ABSENT),
      input: (id: bigint) => void registers.set(id, call.args),
      value_return: (len: bigint, ptr: bigint) => {
        value = read(ptr, len);
      },
      panic_utf8: (len: bigint, ptr: bigint) => {
        throw new GuestPanic(text(ptr, len));
      },
      log_utf8: (len: bigint, ptr: bigint) => void logs.push(text(ptr, len)),
      sha256: (len: bigint, ptr: bigint, id: bigint) =>
        void registers.set(id, createHash("sha256").update(read(ptr, len)).digest()),
      block_timestamp: () => this.now,
      prepaid_gas: () => call.gas,
      attached_deposit: (ptr: bigint) => {
        const bytes = mem();
        let rest = call.deposit;
        for (let i = 0; i < 16; i++) {
          bytes[Number(ptr) + i] = Number(rest & 0xffn);
          rest >>= 8n;
        }
      },
      predecessor_account_id: (id: bigint) =>
        void registers.set(id, encoder.encode(call.predecessor)),
      current_account_id: (id: bigint) => void registers.set(id, encoder.encode(self)),
      storage_read: (keyLen: bigint, keyPtr: bigint, id: bigint) => {
        const found = account.storage.get(key(keyPtr, keyLen));
        if (!found) return 0n;
        registers.set(id, found);
        return 1n;
      },
      storage_write: (
        keyLen: bigint,
        keyPtr: bigint,
        valueLen: bigint,
        valuePtr: bigint,
        id: bigint,
      ) => {
        const name = key(keyPtr, keyLen);
        const old = account.storage.get(name);
        account.storage.set(name, read(valuePtr, valueLen));
        if (!old) return 0n;
        registers.set(id, old);
        return 1n;
      },
      storage_remove: (keyLen: bigint, keyPtr: bigint, id: bigint) => {
        const name = key(keyPtr, keyLen);
        const old = account.storage.get(name);
        if (!old) return 0n;
        account.storage.delete(name);
        registers.set(id, old);
        return 1n;
      },
      storage_has_key: (keyLen: bigint, keyPtr: bigint) =>
        account.storage.has(key(keyPtr, keyLen)) ? 1n : 0n,
      promise_batch_create: (len: bigint, ptr: bigint) => {
        promises.push({ receiver: text(ptr, len), actions: [], deps: [] });
        return BigInt(promises.length - 1);
      },
      promise_batch_then: (after: bigint, len: bigint, ptr: bigint) => {
        promise(after);
        promises.push({ receiver: text(ptr, len), actions: [], deps: [Number(after)] });
        return BigInt(promises.length - 1);
      },
      promise_return: (index: bigint) => {
        promise(index);
        returned = Number(index);
      },
      promise_result: (index: bigint, id: bigint) => {
        const result = call.results[Number(index)];
        if (!result) throw new GuestPanic("no such promise result");
        if (!result.ok) return 2n;
        registers.set(id, result.value);
        return 1n;
      },
      promise_batch_action_transfer: (index: bigint, amountPtr: bigint) => {
        const amount = u128(amountPtr);
        spend(amount);
        promise(index).actions.push({ kind: "transfer", amount });
      },
      promise_batch_action_function_call: addCall,
      promise_batch_action_function_call_weight: addCall,
    };

    const imports: Record<string, unknown> = {};
    for (const { module, name, kind } of WebAssembly.Module.imports(account.module)) {
      if (module !== "env" || kind !== "function") {
        throw new Error(`unexpected import ${module}.${name}`);
      }
      imports[name] = host[name] ?? unsupported(name);
    }

    let outcome: Outcome;
    try {
      const instance = new WebAssembly.Instance(account.module, {
        env: imports as WebAssembly.ModuleImports,
      });
      memory = instance.exports.memory as WebAssembly.Memory;
      const entry = instance.exports[call.method];
      if (typeof entry !== "function") {
        outcome = { ok: false, error: `MethodNotFound: ${call.method}` };
      } else {
        (entry as () => void)();
        outcome = { ok: true, value };
      }
    } catch (error) {
      if (error instanceof GuestPanic || error instanceof WebAssembly.RuntimeError) {
        outcome = { ok: false, error: error.message };
      } else {
        throw error;
      }
    }
    // A failed receipt still reports its logs, as on the real network.
    call.logs.push(...logs);
    return { outcome, promises, ...(returned === undefined ? {} : { returned }) };
  }
}

export class TxHandle {
  private readonly runtime: NearRuntime;
  private readonly id: number;
  private readonly refused: KeyRefusal | undefined;

  constructor(runtime: NearRuntime, id: number, refused?: KeyRefusal) {
    this.runtime = runtime;
    this.id = id;
    this.refused = refused;
  }

  result(): TxResult {
    if (this.refused) return { refused: this.refused, pending: false, logs: [] };
    return this.runtime.resultOf(this.id);
  }
}

/** What a function call access key lets through, per the NEAR protocol. */
function refusal(key: AccessKey, receiver: string, action: Action): KeyRefusal | undefined {
  if (key.kind === "full") return undefined;
  if (action.kind !== "call") return "KEY_ACTION_NOT_ALLOWED";
  if (receiver !== key.receiver || !key.methods.includes(action.method)) {
    return "KEY_METHOD_NOT_ALLOWED";
  }
  return action.deposit > 0n ? "KEY_DEPOSIT_NOT_ALLOWED" : undefined;
}

function attachedValue(action: Action): bigint {
  if (action.kind === "transfer") return action.amount;
  return action.kind === "call" ? action.deposit : 0n;
}
