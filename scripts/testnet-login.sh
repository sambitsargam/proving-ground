#!/usr/bin/env bash
# Logs the OutLayer CLI in as the owner. Run this yourself. The key goes from the saved
# credentials file straight to the CLI, so it is never shown or typed anywhere.
set -euo pipefail

OWNER=provingground-owner.testnet
OUTLAYER=${OUTLAYER:-outlayer}

node -e '
  const [account] = process.argv.slice(1);
  const path = `${process.env.HOME}/.near-credentials/testnet/${account}.json`;
  const { private_key: key } = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
  process.stdout.write(`${account}\n${key}\n`);
' "$OWNER" | "$OUTLAYER" login testnet
