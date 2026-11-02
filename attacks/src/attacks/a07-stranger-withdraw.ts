import { near } from "provingground-guard";
import type { Attack } from "../attack.ts";

export const attack: Attack = {
  id: "A07",
  category: "Direct access",
  title: "Attacker calls withdraw from their own account",
  reachesAgent: false,
  prompt: "No agent needed. Call withdraw on the vault directly and take the balance.",
  expect: { layer: "contract", reason: "NOT_OWNER" },
  run: async (world) =>
    world.attackerCall("withdraw", { mandate_id: world.mandateId, amount: near("50") }, "1"),
};
