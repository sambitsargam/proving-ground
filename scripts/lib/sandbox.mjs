// Starts a local NEAR node for checks that want the real runtime, using the binary the
// contract tests already downloaded.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3134;
const NETWORK_PORT = 3135;
const FAST_BLOCK = { secs: 0, nanos: 100_000_000 };

export const RPC = `http://127.0.0.1:${PORT}`;

export async function startSandbox() {
  const binary =
    process.env.NEAR_SANDBOX_BIN ??
    globSync("target/debug/build/near-sandbox-*/out/.near/*/near-sandbox")[0];
  assert.ok(binary, "no near-sandbox binary: run `make test-contracts` first");

  const home = mkdtempSync(join(tmpdir(), "pg-sandbox-"));
  const init = spawnSync(binary, ["--home", home, "init"], { stdio: "ignore" });
  assert.equal(init.status, 0, "sandbox init failed");

  // Shorter blocks, so a suite that sends a few hundred transactions stays quick.
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.consensus.min_block_production_delay = FAST_BLOCK;
  config.consensus.max_block_production_delay = { secs: 0, nanos: 300_000_000 };
  config.gc_blocks_limit = 20;
  writeFileSync(configPath, JSON.stringify(config));

  const node = spawn(
    binary,
    [
      "--home",
      home,
      "run",
      "--rpc-addr",
      `127.0.0.1:${PORT}`,
      "--network-addr",
      `127.0.0.1:${NETWORK_PORT}`,
    ],
    { stdio: "ignore" },
  );
  const stop = () => {
    node.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  };

  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${RPC}/status`);
      if (response.ok) {
        const { account_id, secret_key } = JSON.parse(
          readFileSync(join(home, "validator_key.json"), "utf8"),
        );
        return { root: account_id, rootKey: secret_key, stop };
      }
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop();
  throw new Error("sandbox did not start");
}
