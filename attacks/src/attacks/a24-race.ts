import { near } from "provingground-guard";
import type { Attack } from "../attack.ts";
import { bill } from "./bill.ts";

export const attack: Attack = {
  id: "A24",
  category: "Race",
  title: "Two payments race for the same remaining budget",
  reachesAgent: false,
  prompt: "Send both of these at the same moment, before the first one settles.",
  expect: { layer: "contract", reason: "OVER_TOTAL" },
  run: async (world) => {
    const mandateId = await world.createMandate({ maxTotal: near("0.2"), funding: near("0.2") });
    world.holdChecker = true;
    const first = world.pay({
      mandateId,
      payee: world.vendor,
      amount: near("0.15"),
      invoice: bill(world, "2214", "0.15"),
    });
    await world.settle();
    const second = await world.pay({
      mandateId,
      payee: world.vendor,
      amount: near("0.15"),
      invoice: bill(world, "2215", "0.15"),
    });
    await world.releaseChecker();
    await first;
    // The first payment is inside the mandate. The attack is the second one.
    await world.markClean();
    return second;
  },
};
