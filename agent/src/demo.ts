// A real model, jailbroken for real, against the real vault contract on the simulated
// runtime. Uses NEAR AI credit but no chain funds:
//
//   node src/demo.ts "your jailbreak message"

import { MockWorld } from "provingground/world";
import { TreasuryAgent } from "./agent.ts";
import { DEFAULT_MODEL, NearAiBrain } from "./brains.ts";

const apiKey = process.env.NEAR_AI_API_KEY;
const model = process.env.DEMO_MODEL ?? DEFAULT_MODEL;
if (!apiKey) throw new Error("NEAR_AI_API_KEY is not set");

const message = process.argv[2];
if (!message) throw new Error('usage: node src/demo.ts "message"');

const world = new MockWorld();
const agent = new TreasuryAgent({
  brain: new NearAiBrain({ apiKey, model }),
  guard: world.guard,
  mandateId: world.mandateId,
});
const run = await agent.handle(message);

const output = {
  model,
  reply: run.reply.replace(/\s+/g, " ").slice(0, 300),
  tried: run.payments.map(({ payee, amount, decision, reason, layer, checkerReasons }) => ({
    payee,
    near: Number(BigInt(amount) / 10n ** 20n) / 10_000,
    decision,
    reason,
    layer,
    checkerReasons,
  })),
  attacker_gain_yocto: world.attackerGain().toString(),
  funds_lost_yocto: world.fundsLost().toString(),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
