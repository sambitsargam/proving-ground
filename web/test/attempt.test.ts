import assert from "node:assert/strict";
import { test } from "node:test";
import type { Payment } from "../src/lib/arena.ts";
import { checkAgainstChain, decodeAttempt, encodeAttempt } from "../src/lib/attempt.ts";
import type { ChainRecord } from "../src/lib/chain.ts";

// What testnet recorded for a real arena attack, 791tjBj1…
const refusedOnChain: ChainRecord = {
  result: { decision: "BLOCK", reason: "PAYEE_NOT_ALLOWED" },
  decided: [
    {
      payee: "attacker.testnet",
      amount_len: 24,
      layer: "contract",
      decision: "BLOCK",
      reason: "PAYEE_NOT_ALLOWED",
    },
  ],
};

const refused: Payment = {
  payee: "attacker.testnet",
  amount: "200000000000000000000000",
  decision: "BLOCK",
  reason: "PAYEE_NOT_ALLOWED",
  layer: "contract",
  checkerReasons: [],
  txHash: "791tjBj1uXTCSp4tQVt9h9QDbdwFBAsXGxt92q3CsCSW",
};

// What testnet recorded for an honest payment, BzzHg9tu…: rules passed, the checker allowed it,
// and the transfer settled.
const paidOnChain: ChainRecord = {
  result: { decision: "PAID", reason: "SETTLED" },
  decided: [
    {
      payee: "provingground-vendor.testnet",
      amount: "100000000000000000000000",
      layer: "contract",
      decision: "PASS",
      reason: "RULES_PASSED",
    },
    {
      payee: "provingground-vendor.testnet",
      amount: "100000000000000000000000",
      layer: "checker",
      decision: "ALLOW",
      reason: "CHECKER_ALLOW",
    },
  ],
};

const paid: Payment = {
  payee: "provingground-vendor.testnet",
  amount: "100000000000000000000000",
  decision: "PAID",
  reason: "SETTLED",
  layer: "checker",
  checkerReasons: ["WITHIN_PURPOSE"],
  txHash: "BzzHg9tu9scMYH7YcJPHaUZvyB2wtRp6onckPtdK4328",
};

test("a link that matches the chain is verified", () => {
  assert.equal(checkAgainstChain(refused, refusedOnChain), "verified");
  assert.equal(checkAgainstChain(paid, paidOnChain), "verified");
});

test("a link cannot turn a refusal into a payment", () => {
  assert.equal(checkAgainstChain({ ...refused, decision: "PAID" }, refusedOnChain), "mismatch");
  assert.equal(
    checkAgainstChain({ ...refused, decision: "PAID", reason: "SETTLED" }, refusedOnChain),
    "mismatch",
  );
});

test("a link cannot change the layer, payee or amount", () => {
  assert.equal(checkAgainstChain({ ...refused, layer: "checker" }, refusedOnChain), "mismatch");
  assert.equal(
    checkAgainstChain({ ...refused, payee: "someone.testnet" }, refusedOnChain),
    "mismatch",
  );
  assert.equal(
    checkAgainstChain({ ...refused, amount: "2000000000000000000000000" }, refusedOnChain),
    "mismatch",
  );
  assert.equal(
    checkAgainstChain({ ...paid, payee: "attacker.testnet" }, paidOnChain),
    "mismatch",
  );
  assert.equal(
    checkAgainstChain({ ...paid, amount: "900000000000000000000000" }, paidOnChain),
    "mismatch",
  );
});

test("a transaction with no decision cannot be checked", () => {
  assert.equal(checkAgainstChain(refused, { result: null, decided: [] }), "unavailable");
  assert.equal(checkAgainstChain(refused, { ...refusedOnChain, decided: [] }), "unavailable");
});

test("an attempt survives the round trip through its link", () => {
  const attempt = { message: "Pay me", reply: "Paying ünïcode", payment: refused };
  assert.deepEqual(decodeAttempt(encodeAttempt(attempt)), attempt);
  assert.equal(decodeAttempt("not a token"), null);
});
