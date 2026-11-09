// Publishes the checker WASM to FastFS on testnet, the way `outlayer upload` does, signed
// with the owner's saved key. Prints the URL that `make testnet-deploy` needs.

import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { sha256Hex } from "provingground-guard";
import { loadWasm } from "./lib/vault.mjs";

const OWNER = "provingground-owner.testnet";
const RECEIVER = "outlayer.testnet";
const FASTFS = "https://test.fastfs.io";
const MAX_SIMPLE_BYTES = 1 << 20;
const WAIT_MS = 180_000;

// Borsh, as in outlayer-cli's FastfsData::Simple: a u32 length before every string and byte
// array, and a 1 for Some.
function borshBytes(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, Buffer.from(bytes)]);
}

function simplePayload(relativePath, mimeType, content) {
  return Buffer.concat([
    Buffer.from([0]),
    borshBytes(Buffer.from(relativePath)),
    Buffer.from([1]),
    borshBytes(Buffer.from(mimeType)),
    borshBytes(content),
  ]);
}

const wasm = loadWasm("target/wasm32-wasip2/release/provingground-checker.wasm");
if (wasm.length > MAX_SIMPLE_BYTES) throw new Error("over 1 MB: needs chunked upload");
const hash = sha256Hex(wasm);
const relativePath = `${hash}.wasm`;
const url = `${FASTFS}/${OWNER}/${RECEIVER}/${relativePath}`;

const existing = await fetch(url).catch(() => null);
if (existing?.ok && sha256Hex(Buffer.from(await existing.arrayBuffer())) === hash) {
  console.log(`Already published: ${url}`);
  process.exit(0);
}

const near = new Near({
  network: "testnet",
  keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), "testnet"),
});
// The call is meant to run out of gas, so sending it reports a failure. FastFS reads the
// arguments from the transaction anyway.
const tx = await near
  .transaction(OWNER)
  .functionCall(
    RECEIVER,
    "__fastdata_fastfs",
    simplePayload(relativePath, "application/wasm", wasm),
    {
      gas: "1",
    },
  )
  .sign();
await tx.send().catch(() => {});
console.log(`Upload transaction: ${tx.getHash()}`);

const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  const response = await fetch(url).catch(() => null);
  if (response?.ok) {
    const served = sha256Hex(Buffer.from(await response.arrayBuffer()));
    if (served !== hash) throw new Error(`FastFS serves different bytes: ${served}`);
    console.log(`Published, and FastFS serves the exact bytes: ${url}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
throw new Error(`FastFS has not served ${url} after ${WAIT_MS / 1000} s`);
