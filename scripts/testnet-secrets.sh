#!/usr/bin/env bash
# Stores the checker's secrets on OutLayer, readable only by this exact WASM build and only
# on behalf of the vault. Run this yourself after `outlayer login testnet`.
set -euo pipefail

set -a
. ./.env
set +a

: "${NEAR_AI_API_KEY:?missing from .env}"
: "${CHECKER_SECRET_KEY:?missing from .env. Run make testnet-deploy first}"
: "${BLOB_BASE_URL:?missing from .env}"

hash=$(shasum -a 256 target/wasm32-wasip2/release/provingground-checker.wasm | cut -d' ' -f1)
secrets=$(node -e 'console.log(JSON.stringify({
  NEAR_AI_API_KEY: process.env.NEAR_AI_API_KEY,
  CHECKER_SECRET_KEY: process.env.CHECKER_SECRET_KEY,
  BLOB_BASE_URL: process.env.BLOB_BASE_URL,
}))')

outlayer secrets set "$secrets" \
  --profile checker \
  --wasm-hash "$hash" \
  --access whitelist:provingground-vault.testnet
