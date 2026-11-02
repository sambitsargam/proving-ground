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

## 4. Secrets

The blob store has to be reachable from OutLayer's workers, so set `BLOB_BASE_URL` in `.env` to its public address first. Then:

```bash
./scripts/testnet-secrets.sh
```

## 5. Demo state

```bash
make demo-reset
```

## 6. Lock the vault

Before the bounty opens, delete every full-access key on the vault account. Nothing can then change its code. **This cannot be undone.** Fixes after that are a new deployment.
