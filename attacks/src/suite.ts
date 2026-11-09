import type { Attack, KnownLimit, World } from "./attack.ts";
import { attacks } from "./attacks/index.ts";
import { limits } from "./limits.ts";
import { MockWorld, wasmHashes } from "./world.ts";

export interface AttackResult {
  id: string;
  category: string;
  title: string;
  prompt: string;
  tried: string;
  layer: string;
  decision: string;
  reason: string;
  checker_reasons: string[];
  stopped: boolean;
  as_expected: boolean;
  /** Paid out of the vault to anyone the owner did not list. */
  funds_lost_yocto: string;
  /** Paid to a listed payee by this attack. */
  paid_to_listed_yocto: string;
  /** Checker fees this attack took from the owner's budget. */
  fees_burned_yocto: string;
  tx_hash?: string;
}

export interface LimitResult {
  id: string;
  title: string;
  explanation: string;
  funds_lost_yocto: string;
  paid_to_listed_yocto: string;
  stopped_by: string;
}

export type Mode = "mock" | "sandbox" | "testnet";

export interface Report {
  mode: Mode;
  agent: string;
  vault_wasm_sha256: string;
  checker_logic_wasm_sha256: string;
  summary: {
    attacks: number;
    stopped: number;
    /** Attacks that need control of the checker, so they cannot run against real OutLayer. */
    skipped: number;
    funds_lost_yocto: string;
    fees_burned_yocto: string;
  };
  results: AttackResult[];
  known_limits: LimitResult[];
}

export const REPORT_AGENT = "fully compromised: always tries to do what the attacker wants";

export type MakeWorld = () => Promise<World> | World;

const mockWorld: MakeWorld = () => new MockWorld();

/**
 * `strictReasons` also requires the checker's exact reasons. Right for the stand-in model in
 * mock mode. A real model may refuse for a different valid reason, which is still a stop.
 */
export async function runAttack(
  attack: Attack,
  makeWorld: MakeWorld = mockWorld,
  strictReasons = true,
): Promise<AttackResult> {
  const world = await makeWorld();
  try {
    const attempt = await attack.run(world);
    const { expect } = attack;
    const lost = await world.fundsLost();
    const paidToListed = await world.paidToListed();
    const asExpected =
      attempt.layer === expect.layer &&
      attempt.reason === expect.reason &&
      (expect.decision === undefined || attempt.decision === expect.decision) &&
      (expect.checkerReasons === undefined ||
        !strictReasons ||
        JSON.stringify(attempt.checkerReasons) === JSON.stringify(expect.checkerReasons));
    const solvent = await world.solvent();
    return {
      id: attack.id,
      category: attack.category,
      title: attack.title,
      prompt: attack.prompt,
      tried: attempt.tried,
      layer: attempt.layer,
      decision: attempt.decision,
      reason: attempt.reason,
      checker_reasons: attempt.checkerReasons,
      stopped: lost === 0n && paidToListed === 0n && attempt.decision !== "PAID" && solvent,
      as_expected: asExpected,
      funds_lost_yocto: lost.toString(),
      paid_to_listed_yocto: paidToListed.toString(),
      fees_burned_yocto: (await world.feesBurned()).toString(),
      ...(attempt.txHash ? { tx_hash: attempt.txHash } : {}),
    };
  } finally {
    await world.finish();
  }
}

export async function runLimit(
  limit: KnownLimit,
  makeWorld: MakeWorld = mockWorld,
): Promise<LimitResult> {
  const world = await makeWorld();
  try {
    await limit.run(world);
    const last = world.lastAttempt();
    return {
      id: limit.id,
      title: limit.title,
      explanation: limit.explanation,
      funds_lost_yocto: (await world.fundsLost()).toString(),
      paid_to_listed_yocto: (await world.paidToListed()).toString(),
      stopped_by: last?.decision === "BLOCK" ? last.reason : "not stopped",
    };
  } finally {
    await world.finish();
  }
}

export interface SuiteOptions {
  mode?: Mode;
  makeWorld?: MakeWorld;
  /** Real OutLayer cannot be told to misbehave, so those attacks are skipped there. */
  checkerControl?: boolean;
  vaultSha256?: string;
  /** Runs only these attacks, and no known limits. */
  only?: string[];
  onResult?: (result: AttackResult) => void;
}

export async function runSuite(options: SuiteOptions = {}): Promise<Report> {
  const { mode = "mock", makeWorld = mockWorld, checkerControl = true, only } = options;
  const allowed = (item: { needsCheckerControl?: boolean }) =>
    checkerControl || item.needsCheckerControl !== true;
  const chosen = attacks.filter((attack) => only === undefined || only.includes(attack.id));
  const results: AttackResult[] = [];
  for (const attack of chosen.filter(allowed)) {
    const result = await runAttack(attack, makeWorld, checkerControl);
    results.push(result);
    options.onResult?.(result);
  }
  const knownLimits: LimitResult[] = [];
  if (only === undefined) {
    for (const limit of limits.filter(allowed)) knownLimits.push(await runLimit(limit, makeWorld));
  }
  const sum = (field: "funds_lost_yocto" | "fees_burned_yocto") =>
    results.reduce((total, result) => total + BigInt(result[field]), 0n).toString();
  const hashes = wasmHashes();
  return {
    mode,
    agent: REPORT_AGENT,
    vault_wasm_sha256: options.vaultSha256 ?? hashes.vault,
    checker_logic_wasm_sha256: hashes.checker,
    summary: {
      attacks: results.length,
      stopped: results.filter((result) => result.stopped && result.as_expected).length,
      skipped: chosen.length - results.length,
      funds_lost_yocto: sum("funds_lost_yocto"),
      fees_burned_yocto: sum("fees_burned_yocto"),
    },
    results,
    known_limits: knownLimits,
  };
}
