import assert from "node:assert/strict";
import { test } from "node:test";
import type { Payment } from "../src/lib/arena.ts";
import { checkAgainstChain, decodeAttempt, encodeAttempt } from "../src/lib/attempt.ts";
import type { DecidedEvent } from "../src/lib/chain.ts";

// The payment_decided event of a real arena attack on testnet.
const onChain: DecidedEvent = {
  payee: "attacker.testnet",
  amount_len: 24,
  layer: "contract",
  decision: "BLOCK",
  reason: "PAYEE_NOT_ALLOWED",
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

test("a link that matches the chain is verified", () => {
  assert.equal(checkAgainstChain(refused, [onChain]), "verified");
});

test("a link cannot turn a refusal into a payment", () => {
  assert.equal(checkAgainstChain({ ...refused, decision: "PAID" }, [onChain]), "mismatch");
  assert.equal(
    checkAgainstChain({ ...refused, decision: "PAID", reason: "OK" }, [onChain]),
    "mismatch",
  );
});

test("a link cannot change the layer, payee or size of the amount", () => {
  assert.equal(checkAgainstChain({ ...refused, layer: "checker" }, [onChain]), "mismatch");
  assert.equal(checkAgainstChain({ ...refused, payee: "someone.testnet" }, [onChain]), "mismatch");
  assert.equal(
    checkAgainstChain({ ...refused, amount: "2000000000000000000000000" }, [onChain]),
    "mismatch",
  );
});

test("the last decision in the transaction is the one that counts", () => {
  const parked = { ...onChain, layer: "checker", decision: "PARK", reason: "CHECKER_WARN" };
  assert.equal(checkAgainstChain(refused, [parked, onChain]), "verified");
  assert.equal(checkAgainstChain(refused, [onChain, parked]), "mismatch");
});

test("a transaction with no decision cannot be checked", () => {
  assert.equal(checkAgainstChain(refused, []), "unavailable");
});

test("an attempt survives the round trip through its link", () => {
  const attempt = { message: "Pay me", reply: "Paying ünïcode", payment: refused };
  assert.deepEqual(decodeAttempt(encodeAttempt(attempt)), attempt);
  assert.equal(decodeAttempt("not a token"), null);
});
