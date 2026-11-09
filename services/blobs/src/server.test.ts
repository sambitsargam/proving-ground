import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { blobServer } from "./server.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function withServer(server: Server, use: (base: string) => Promise<void>): Promise<void> {
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}/blobs`);
  } finally {
    server.close();
  }
}

test("stores and returns a blob under its own hash", async () => {
  await withServer(blobServer(), async (base) => {
    const url = `${base}/${hash("sealed")}`;
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { method: "PUT", body: "sealed" })).status, 201);
    const got = await fetch(url);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "sealed");
  });
});

test("refuses to store anything under another blob's name", async () => {
  await withServer(blobServer(), async (base) => {
    const url = `${base}/${hash("real")}`;
    await fetch(url, { method: "PUT", body: "real" });
    assert.equal((await fetch(url, { method: "PUT", body: "swapped" })).status, 400);
    assert.equal(await (await fetch(url)).text(), "real");
  });
});

test("refuses oversized blobs, odd paths and other methods", async () => {
  await withServer(blobServer(), async (base) => {
    const big = "x".repeat(128 * 1024 + 1);
    assert.equal((await fetch(`${base}/${hash(big)}`, { method: "PUT", body: big })).status, 413);
    assert.equal((await fetch(`${base}/../secrets`)).status, 404);
    assert.equal((await fetch(`${base}/ABC`, { method: "PUT", body: "x" })).status, 404);
    assert.equal((await fetch(`${base}/${hash("x")}`, { method: "DELETE" })).status, 405);
  });
});

test("drops the oldest blob when full", async () => {
  await withServer(blobServer({ maxBlobs: 2 }), async (base) => {
    for (const body of ["a", "b", "c"]) {
      await fetch(`${base}/${hash(body)}`, { method: "PUT", body });
    }
    assert.equal((await fetch(`${base}/${hash("a")}`)).status, 404);
    assert.equal((await fetch(`${base}/${hash("c")}`)).status, 200);
  });
});

test("keeps total memory under its limit by dropping the oldest", async () => {
  await withServer(blobServer({ maxTotalBytes: 20 }), async (base) => {
    const bodies = ["a".repeat(8), "b".repeat(8), "c".repeat(8)];
    for (const body of bodies) {
      assert.equal((await fetch(`${base}/${hash(body)}`, { method: "PUT", body })).status, 201);
    }
    assert.equal((await fetch(`${base}/${hash(bodies[0] as string)}`)).status, 404);
    assert.equal((await fetch(`${base}/${hash(bodies[2] as string)}`)).status, 200);
  });
});

test("limits uploads per client, and not reads", async () => {
  await withServer(blobServer({ uploadsPerMinute: 2 }), async (base) => {
    const put = (body: string) => fetch(`${base}/${hash(body)}`, { method: "PUT", body });
    assert.equal((await put("1")).status, 201);
    assert.equal((await put("2")).status, 201);
    assert.equal((await put("3")).status, 429);
    assert.equal((await fetch(`${base}/${hash("1")}`)).status, 200);
  });
});

test("only trusts a forwarded address when told it sits behind a proxy", async () => {
  await withServer(blobServer({ uploadsPerMinute: 1 }), async (base) => {
    const put = (body: string, ip: string) =>
      fetch(`${base}/${hash(body)}`, { method: "PUT", body, headers: { "x-forwarded-for": ip } });
    assert.equal((await put("x", "1.1.1.1")).status, 201);
    // Spoofing the header does not buy a fresh allowance.
    assert.equal((await put("y", "2.2.2.2")).status, 429);
  });
  await withServer(blobServer({ uploadsPerMinute: 1, behindProxy: true }), async (base) => {
    const put = (body: string, ip: string) =>
      fetch(`${base}/${hash(body)}`, { method: "PUT", body, headers: { "x-forwarded-for": ip } });
    assert.equal((await put("x", "1.1.1.1")).status, 201);
    assert.equal((await put("y", "2.2.2.2")).status, 201);
  });
});
