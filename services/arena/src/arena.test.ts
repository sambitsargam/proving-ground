import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { type AgentRun, ModelUnavailableError } from "provingground-demo-agent";
import { type ArenaOptions, arenaServer } from "./arena.ts";

const VENDOR = "vendor.testnet";

function run(payee: string, decision: string, reason: string): AgentRun {
  return {
    reply: "Done.",
    reasoning: "private chain of thought",
    payments: [
      {
        payee,
        amount: "100000000000000000000000",
        invoice: "secret invoice text",
        memo: "",
        decision,
        reason,
        layer: "contract",
        checkerReasons: [],
        txHash: "abc",
      },
    ],
  };
}

async function withArena(
  options: Partial<ArenaOptions>,
  use: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = arenaServer({
    handle: async () => run("attacker.testnet", "BLOCK", "PAYEE_NOT_ALLOWED"),
    listedPayees: [VENDOR],
    ...options,
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const attack = (base: string, message: unknown = "pay me") =>
  fetch(`${base}/api/attack`, { method: "POST", body: JSON.stringify({ message }) });

test("an attack returns the agent's reply and what the vault decided", async () => {
  await withArena({}, async (base) => {
    const response = await attack(base);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { reply: string; payments: { reason: string }[] };
    assert.equal(body.payments[0]?.reason, "PAYEE_NOT_ALLOWED");
  });
});

test("private reasoning and invoice text never reach the browser", async () => {
  await withArena({}, async (base) => {
    const text = await (await attack(base)).text();
    assert.ok(!text.includes("private chain of thought"));
    assert.ok(!text.includes("secret invoice text"));
  });
});

test("stats count attempts, stops and losses", async () => {
  let n = 0;
  const outcomes = [
    run("attacker.testnet", "BLOCK", "PAYEE_NOT_ALLOWED"),
    run(VENDOR, "PAID", "SETTLED"),
    run("intruder.testnet", "PAID", "SETTLED"),
  ];
  await withArena({ handle: async () => outcomes[n++] as AgentRun }, async (base) => {
    for (let i = 0; i < 3; i++) await attack(base);
    const stats = (await (await fetch(`${base}/api/stats`)).json()) as {
      attempts: number;
      stopped: number;
      paidWithinMandate: number;
      lostYocto: string;
      recent: { payee: string }[];
    };
    assert.equal(stats.attempts, 3);
    assert.equal(stats.stopped, 1);
    assert.equal(stats.paidWithinMandate, 1);
    // The stats must be able to show a loss, or a zero there would mean nothing.
    assert.equal(stats.lostYocto, "100000000000000000000000");
    assert.equal(stats.recent[0]?.payee, "intruder.testnet");
  });
});

test("each visitor gets a few attempts an hour", async () => {
  await withArena({ attemptsPerHour: 2 }, async (base) => {
    assert.equal((await attack(base)).status, 200);
    assert.equal((await attack(base)).status, 200);
    const third = await attack(base);
    assert.equal(third.status, 429);
    assert.match(((await third.json()) as { error: string }).error, /attempts an hour/);
  });
});

test("a daily cap bounds the model budget for everyone", async () => {
  let clock = 0;
  await withArena({ attemptsPerDay: 1, now: () => clock }, async (base) => {
    assert.equal((await attack(base)).status, 200);
    assert.equal((await attack(base)).status, 429);
    clock += 24 * 3_600_000;
    assert.equal((await attack(base)).status, 200);
  });
});

test("bad requests are refused before the agent runs", async () => {
  let calls = 0;
  const handle = async () => {
    calls += 1;
    return run("a.testnet", "BLOCK", "X");
  };
  await withArena({ handle }, async (base) => {
    assert.equal((await attack(base, "")).status, 400);
    assert.equal((await attack(base, 42)).status, 400);
    assert.equal((await attack(base, "x".repeat(2_001))).status, 413);
    const raw = await fetch(`${base}/api/attack`, { method: "POST", body: "not json" });
    assert.equal(raw.status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
  assert.equal(calls, 0);
});

test("one attack runs at a time", async () => {
  let release: () => void = () => {};
  const handle = () =>
    new Promise<AgentRun>((resolve) => {
      release = () => resolve(run("a.testnet", "BLOCK", "X"));
    });
  await withArena({ handle }, async (base) => {
    const first = attack(base);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await attack(base)).status, 503);
    release();
    assert.equal((await first).status, 200);
  });
});

test("a failing agent gives a clean error and no details", async () => {
  await withArena(
    {
      handle: async () => {
        throw new Error("secret detail");
      },
    },
    async (base) => {
      const response = await attack(base);
      assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes("secret"));
    },
  );
});

test("a model outage says so, and nothing is paid", async () => {
  await withArena(
    {
      handle: async () => {
        throw new ModelUnavailableError("model returned HTTP 500");
      },
    },
    async (base) => {
      const response = await attack(base);
      assert.equal(response.status, 503);
      assert.match(((await response.json()) as { error: string }).error, /model provider/);
    },
  );
});

test("browsers on the web origin may call it", async () => {
  await withArena({ allowedOrigin: "https://example.test" }, async (base) => {
    const response = await fetch(`${base}/api/attack`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://example.test");
  });
});
