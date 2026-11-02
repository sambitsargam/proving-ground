import type { Attack, KnownLimit } from "./attack.ts";
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
  /** Checker fees this attack burned from the owner's budget. */
  fees_burned_yocto: string;
}

export interface LimitResult {
  id: string;
  title: string;
  explanation: string;
  funds_lost_yocto: string;
  paid_to_listed_yocto: string;
  stopped_by: string;
}

export interface Report {
  mode: "mock";
  agent: string;
  vault_wasm_sha256: string;
  checker_logic_wasm_sha256: string;
  summary: {
    attacks: number;
    stopped: number;
    funds_lost_yocto: string;
    fees_burned_yocto: string;
  };
  results: AttackResult[];
  known_limits: LimitResult[];
}

export const REPORT_AGENT = "fully compromised: always tries to do what the attacker wants";

export async function runAttack(attack: Attack): Promise<AttackResult> {
  const world = new MockWorld();
  const attempt = await attack.run(world);
  const { expect } = attack;
  const lost = world.fundsLost() + world.attackerGain();
  const paidToListed = world.paidToListed();
  const asExpected =
    attempt.layer === expect.layer &&
    attempt.reason === expect.reason &&
    (expect.decision === undefined || attempt.decision === expect.decision) &&
    (expect.checkerReasons === undefined ||
      JSON.stringify(attempt.checkerReasons) === JSON.stringify(expect.checkerReasons));
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
    stopped: lost === 0n && paidToListed === 0n && attempt.decision !== "PAID" && world.solvent(),
    as_expected: asExpected,
    funds_lost_yocto: lost.toString(),
    paid_to_listed_yocto: paidToListed.toString(),
    fees_burned_yocto: world.feesBurned().toString(),
  };
}

export async function runLimit(limit: KnownLimit): Promise<LimitResult> {
  const world = new MockWorld();
  await limit.run(world);
  const last = world.attempts.at(-1);
  return {
    id: limit.id,
    title: limit.title,
    explanation: limit.explanation,
    funds_lost_yocto: (world.fundsLost() + world.attackerGain()).toString(),
    paid_to_listed_yocto: world.paidToListed().toString(),
    stopped_by: last?.decision === "BLOCK" ? last.reason : "not stopped",
  };
}

export async function runSuite(): Promise<Report> {
  const results: AttackResult[] = [];
  for (const attack of attacks) results.push(await runAttack(attack));
  const knownLimits: LimitResult[] = [];
  for (const limit of limits) knownLimits.push(await runLimit(limit));
  const sum = (field: "funds_lost_yocto" | "fees_burned_yocto") =>
    results.reduce((total, result) => total + BigInt(result[field]), 0n).toString();
  const hashes = wasmHashes();
  return {
    mode: "mock",
    agent: REPORT_AGENT,
    vault_wasm_sha256: hashes.vault,
    checker_logic_wasm_sha256: hashes.checker,
    summary: {
      attacks: results.length,
      stopped: results.filter((result) => result.stopped && result.as_expected).length,
      funds_lost_yocto: sum("funds_lost_yocto"),
      fees_burned_yocto: sum("fees_burned_yocto"),
    },
    results,
    known_limits: knownLimits,
  };
}
