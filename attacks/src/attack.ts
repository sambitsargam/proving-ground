import type { Layer } from "provingground-guard";
import type { ModelMode } from "./model.ts";

/** One thing a compromised party tried, and what stopped it. */
export interface Attempt {
  tried: string;
  layer: Layer;
  decision: string;
  reason: string;
  checkerReasons: string[];
  txHash?: string;
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

/**
 * Where an attack runs. Mock mode and a real chain both implement this, so one attack
 * definition can be compared across the simulated runtime, a local node and testnet.
 */
export interface World {
  readonly vendor: string;
  readonly attacker: string;
  readonly payroll: string;
  /** The mandate the agent works under. */
  readonly mandateId: string;
  /** Holds checker runs until `releaseChecker`, where the checker can be controlled. */
  holdChecker: boolean;
  /** How the checker's model behaves, where the checker can be controlled. */
  modelMode: ModelMode;
  /** A compromised checker: answers this instead of running. */
  checkerOverride: ((requestId: string) => string | null) | undefined;

  /** The agent pays through the guard SDK with its only key. */
  pay(pay: Pay): Promise<Attempt>;
  /** Waits until a payment sent without awaiting has reached the vault. */
  settle(): Promise<void>;
  /** The agent signs any call its key lets it attempt. */
  agentCall(method: string, args: unknown, deposit?: string): Promise<Attempt>;
  agentTransfer(to: string, amount: string): Promise<Attempt>;
  /** The attacker signs from their own account. */
  attackerCall(method: string, args: unknown, deposit?: string): Promise<Attempt>;
  ownerCall(method: string, args: unknown, deposit?: string): Promise<Attempt>;
  createMandate(overrides?: MandateOverrides): Promise<string>;
  createPayrollMandate(): Promise<string>;
  /** Leaves the agent working under a mandate that has expired. */
  expireMandates(): Promise<void>;
  releaseChecker(): Promise<void>;
  /** Forgets everything so far when counting losses. For legitimate setup payments. */
  markClean(): Promise<void>;

  /** Paid out of the vault to anyone the owner did not list. */
  fundsLost(): Promise<bigint>;
  /** Paid to a payee the owner listed, since the last `markClean`. */
  paidToListed(): Promise<bigint>;
  feesBurned(): Promise<bigint>;
  /** The vault holds at least what its mandates say it holds. */
  solvent(): Promise<boolean>;
  /** The last attempt that was made, for reports. */
  lastAttempt(): Attempt | undefined;
  /** Gives back what the attack's mandates still hold, on a real chain. */
  finish(): Promise<void>;
}

export interface Expected {
  layer: Layer;
  reason: string;
  /** Defaults to whatever the layer says; set it when the distinction matters. */
  decision?: string;
  checkerReasons?: string[];
}

export interface Attack {
  id: string;
  category: string;
  title: string;
  /** What the attacker sends. Used against real agents; the mock agent always obeys. */
  prompt: string;
  /** False when the attack needs no agent, or needs chain state a chat cannot set up. */
  reachesAgent?: boolean;
  /** True when it needs control of the checker, so it cannot run against real OutLayer. */
  needsCheckerControl?: boolean;
  expect: Expected;
  /** Plays a fully compromised agent. Returns the attempt that decides the attack. */
  run(world: World): Promise<Attempt>;
}

/** Something the suite does not stop, shown so the headline stays honest. */
export interface KnownLimit {
  id: string;
  title: string;
  explanation: string;
  needsCheckerControl?: boolean;
  run(world: World): Promise<void>;
}
