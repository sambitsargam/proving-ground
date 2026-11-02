import type { Layer } from "provingground-guard";
import type { Attempt, MockWorld } from "./world.ts";

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
  expect: Expected;
  /** Plays a fully compromised agent. Returns the attempt that decides the attack. */
  run(world: MockWorld): Promise<Attempt> | Attempt;
}

/** Something the suite does not stop, shown so the headline stays honest. */
export interface KnownLimit {
  id: string;
  title: string;
  explanation: string;
  run(world: MockWorld): Promise<void>;
}
