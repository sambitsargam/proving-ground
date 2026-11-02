import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  Guard,
  hashInvoice,
  hashPurpose,
  MemoryBlobStore,
  near,
  type PaymentArgs,
  sha256Hex,
  toPayResult,
  type VaultOutcome,
} from "./index.ts";

const { publicKey } = generateKeyPairSync("x25519");
const checkerPublicKey = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const terms = { purpose: "Monthly hosting", purposeSalt: "ab".repeat(16) };

function outcome(decision: string, reason: string): VaultOutcome {
  return { decision, reason, mandateId: "1", requestId: "7", events: [] };
}

test("near converts exactly", () => {
  assert.equal(near("1"), "1000000000000000000000000");
  assert.equal(near("12.5"), "12500000000000000000000000");
  assert.equal(near("0.000000000000000000000001"), "1");
  for (const bad of ["", "-1", "1e3", "1,5", "1.", "0.0000000000000000000000001"]) {
    assert.throws(() => near(bad), /not a NEAR amount/);
  }
});

test("hashes match what the contract and checker expect", () => {
  assert.equal(
    hashInvoice("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(hashPurpose("c", "6162"), hashInvoice("abc"));
});

test("pay seals the invoice, stores it by content and sends only hashes", async () => {
  const blobs = new MemoryBlobStore();
  const sent: PaymentArgs[] = [];
  const guard = new Guard({
    vault: {
      requestPayment: async (args) => {
        sent.push(args);
        return outcome("PAID", "SETTLED");
      },
    },
    blobs,
    checkerPublicKey,
    mandates: { "1": terms },
  });
  const invoice = "Invoice 1. Very private text. Total due: 12 NEAR";
  const result = await guard.pay({
    mandateId: "1",
    payee: "vendor.testnet",
    amount: near("12"),
    invoice,
  });

  assert.equal(result.paid, true);
  const args = sent[0];
  assert.ok(args);
  assert.equal(args.invoice_hash, hashInvoice(invoice));
  assert.equal(args.memo, "");
  const blob = blobs.blobs.get(args.blob_ref);
  assert.ok(blob);
  assert.equal(args.blob_ref, sha256Hex(blob));
  assert.ok(!blob.includes("private"), "plaintext must not reach the blob store");
  assert.ok(!JSON.stringify(args).includes("private"), "plaintext must not reach the chain");
});

test("sealing is fresh each time, so blob IDs do not reveal repeats", async () => {
  const blobs = new MemoryBlobStore();
  const guard = new Guard({
    vault: { requestPayment: async () => outcome("BLOCK", "REPLAY") },
    blobs,
    checkerPublicKey,
    mandates: { "1": terms },
  });
  const request = { mandateId: "1", payee: "vendor.testnet", amount: "1", invoice: "same" };
  await guard.pay(request);
  await guard.pay(request);
  assert.equal(blobs.blobs.size, 2);
});

test("a refusal is a result, not an error", async () => {
  const guard = new Guard({
    vault: { requestPayment: async () => outcome("BLOCK", "PAYEE_NOT_ALLOWED") },
    blobs: new MemoryBlobStore(),
    checkerPublicKey,
    mandates: { "1": terms },
  });
  const result = await guard.pay({
    mandateId: "1",
    payee: "attacker.testnet",
    amount: "1",
    invoice: "x",
  });
  assert.deepEqual(
    [result.paid, result.parked, result.reason],
    [false, false, "PAYEE_NOT_ALLOWED"],
  );
});

test("unknown mandates and bad keys fail before anything is sent", async () => {
  const blobs = new MemoryBlobStore();
  const vault = {
    requestPayment: async () => {
      throw new Error("must not be called");
    },
  };
  const request = { mandateId: "2", payee: "v.testnet", amount: "1", invoice: "x" };
  const unknown = new Guard({ vault, blobs, checkerPublicKey, mandates: { "1": terms } });
  await assert.rejects(unknown.pay(request), /no purpose text/);
  const badKey = new Guard({ vault, blobs, checkerPublicKey: "zz", mandates: { "2": terms } });
  await assert.rejects(badKey.pay(request), /checker public key/);
  assert.equal(blobs.blobs.size, 0);
});

test("the layer comes from the last decision event", () => {
  const result = toPayResult({
    ...outcome("BLOCK", "CHECKER_BLOCK"),
    events: [
      { event: "payment_decided", data: { layer: "contract", decision: "PASS" } },
      {
        event: "payment_decided",
        data: { layer: "checker", decision: "BLOCK", checker_reasons: ["AMOUNT_MISMATCH"] },
      },
    ],
  });
  assert.equal(result.layer, "checker");
  assert.deepEqual(result.checkerReasons, ["AMOUNT_MISMATCH"]);
});
