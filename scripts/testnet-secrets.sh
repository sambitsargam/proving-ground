#!/usr/bin/env bash
# Stores the checker's secrets on OutLayer. Run this yourself, after
# ./scripts/testnet-login.sh, because it handles the NEAR AI key.
#
# Who can read them, per outlayer-cli's own rules:
#   --wasm-hash  only a run of this exact checker build
#   --access     only when the transaction is signed by our agent
#   --via        only when the call comes through our vault contract
set -euo pipefail

set -a
. ./.env
set +a

: "${NEAR_AI_API_KEY:?missing from .env}"
: "${CHECKER_SECRET_KEY:?missing from .env. Run make testnet-deploy first}"
: "${BLOB_BASE_URL:?missing from .env. Set it to your Render service URL plus /blobs}"

hash=$(node -p 'require("./deployments/testnet.json").checker_wasm_sha256')
vault=$(node -p 'require("./deployments/testnet.json").vault')
agent=$(node -p 'require("./deployments/testnet.json").agent')
built=$(shasum -a 256 target/wasm32-wasip2/release/provingground-checker.wasm | cut -d' ' -f1)
if [ "$built" != "$hash" ]; then
  echo "The local checker build ($built) is not the deployed one ($hash). Run make checker." >&2
  exit 1
fi

secrets=$(node -e 'console.log(JSON.stringify({
  NEAR_AI_API_KEY: process.env.NEAR_AI_API_KEY,
  CHECKER_SECRET_KEY: process.env.CHECKER_SECRET_KEY,
  BLOB_BASE_URL: process.env.BLOB_BASE_URL,
}))')

outlayer secrets set "$secrets" \
  --profile checker \
  --wasm-hash "$hash" \
  --access "whitelist:$agent" \
  --via "$vault"
