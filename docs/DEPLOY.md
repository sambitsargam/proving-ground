# Deploying to testnet

**Status:** every step up to locking has been run on testnet. Locking has not, so the vault and agent accounts still have their full-access keys.

## 1. Accounts

Create each of these, and each gets faucet NEAR. Keys go to `~/.near-credentials`.

```bash
near account create-account sponsor-by-faucet-service provingground-owner.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
near account create-account sponsor-by-faucet-service provingground-vault.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
near account create-account sponsor-by-faucet-service provingground-agent.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
near account create-account sponsor-by-faucet-service provingground-vendor.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
near account create-account sponsor-by-faucet-service provingground-attacker.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

Check them:

```bash
make testnet-check
```

## 2. Checker

Build it, then publish it to FastFS.

```bash
cargo install outlayer-cli --version 0.2.1 --locked
```

This logs the CLI in as the owner, passing the key from the saved credentials file straight to the CLI, so it is never shown:

```bash
./scripts/testnet-login.sh
```

```bash
make checker
```

```bash
outlayer upload target/wasm32-wasip2/release/provingground-checker.wasm
```

## 3. Vault

Pass the URL the upload printed. This deploys the vault, adds the agent's key and generates the checker's key. New keys go to `.env` and are never printed.

```bash
CHECKER_WASM_URL=<url> make testnet-deploy
```

The checker's source and hash are fixed at deployment. A new checker build means a new vault.

## 4. Arena, invoice store and site

The checker fetches sealed invoices over the internet, so the store needs a public address. It runs inside the arena's server, under `/blobs/`. `render.yaml` describes the arena and the static site for Render's free plan.

1. Push the repository to GitHub.
2. In the Render dashboard, create a new Blueprint and pick the repository. Render reads `render.yaml`.
3. Set these on **provingground-arena** in the dashboard:

| Setting | Value |
| --- | --- |
| `AGENT_PRIVATE_KEY` | From `.env` |
| `NEAR_AI_API_KEY` | From `.env` |
| `BLOB_BASE_URL` | The arena's URL plus `/blobs` |
| `WEB_ORIGIN` | The site's URL, so browsers on it may call the arena |
| `ATTEMPTS_PER_HOUR`, `ATTEMPTS_PER_DAY` | Optional. Default 6 per visitor an hour, 300 in total a day |

4. Check `<arena URL>/health` returns 200.
5. Set the same `BLOB_BASE_URL` in `.env`, for the next step.

The site expects the arena at `https://provingground-arena.onrender.com`. If Render gives it another address, set `VITE_ARENA_URL` on **provingground-web** and redeploy it.

A free instance sleeps after 15 minutes without traffic and takes about a minute to wake, and an attack sent meanwhile can fail. To keep it awake, point an uptime monitor at `<arena URL>/health` every 10 minutes. One instance running all month fits in the free plan's 750 hours; two would not. A restart loses stored blobs. That is fine, because each one is read seconds after it is uploaded.

## 5. Secrets

The secrets can be read only by a run of this exact checker build, for a transaction our agent signed, arriving through our vault. Run:

```bash
./scripts/testnet-secrets.sh
```

Run it again whenever `BLOB_BASE_URL` changes, or the checker keeps reading from the old address.

## 6. Demo state

```bash
make demo-reset
```

## 7. Lock the vault

Before the bounty opens, delete every full-access key on the vault account. Nothing can then change its code. **This cannot be undone.** Fixes after that are a new deployment.
