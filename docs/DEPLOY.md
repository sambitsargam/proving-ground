# Deploying to testnet

**Status:** the accounts exist. The remaining steps have not been run on testnet yet. The vault and agent key steps share their code with `make test-sandbox`, which runs them on a local node. The OutLayer steps are from its docs and CLI, and have never been run.

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

## 4. Invoice store

The checker fetches sealed invoices over the internet, so the store needs a public address. `render.yaml` describes it for Render's free plan.

1. Push the repository to GitHub.
2. In the Render dashboard, create a new Blueprint and pick the repository. Render reads `render.yaml`.
3. Check `<service URL>/health` returns 200.
4. Set `BLOB_BASE_URL=<service URL>/blobs` in `.env`.

On the free plan the service sleeps after 15 minutes without traffic, and waking it takes about a minute. The agent's upload wakes it, so the first payment after a quiet spell is slow. A restart loses stored blobs. That is fine, because each one is read seconds after it is uploaded.

## 5. Secrets

The secrets can be read only by a run of this exact checker build, for a transaction our agent signed, arriving through our vault. Run:

```bash
./scripts/testnet-secrets.sh
```

## 6. Arena and site

`render.yaml` also describes the arena's backend and the static site. After Render picks up the new services, set these on **provingground-arena** in the dashboard:

| Setting | Value |
| --- | --- |
| `AGENT_PRIVATE_KEY` | From `.env` |
| `NEAR_AI_API_KEY` | From `.env` |
| `BLOB_BASE_URL` | The invoice store's URL plus `/blobs` |
| `WEB_ORIGIN` | The site's URL, so browsers on it may call the arena |
| `ATTEMPTS_PER_HOUR`, `ATTEMPTS_PER_DAY` | Optional. Default 6 per visitor an hour, 300 in total a day |

The site expects the arena at `https://provingground-arena.onrender.com`. If Render gives it another address, set `VITE_ARENA_URL` on **provingground-web** and redeploy it.

The free arena sleeps after 15 minutes without traffic. The landing page and the arena page wake it when they open, but the first attack after a quiet spell can take about a minute.

## 7. Demo state

```bash
make demo-reset
```

## 8. Lock the vault

Before the bounty opens, delete every full-access key on the vault account. Nothing can then change its code. **This cannot be undone.** Fixes after that are a new deployment.
