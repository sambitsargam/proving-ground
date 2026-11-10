# Architecture

The design rule: everything that decides whether money moves is deterministic code in the vault contract, and the one model in the decision path can only refuse. The agent, its model and its prompts are all treated as compromised.

## Components

| Component | Runs where | Trusted for |
| --- | --- | --- |
| [Vault contract](../contracts/vault) | NEAR | Everything. It holds funds and applies the rules |
| [Decision rules](../contracts/core) | Compiled into the vault, the tests and mock mode | The same, since they are the vault's code |
| [Checker](../services/checker) | WASM in an OutLayer TEE | Only to refuse |
| Checker model | NEAR AI Cloud, in a TEE | Only to refuse, through the checker |
| [Guard SDK](../packages/guard) | The agent's process | Nothing. It is a convenience |
| [Demo agent](../agent) | Our arena server | Nothing |
| [Invoice store](../services/blobs) | Our server | Nothing. It only ever holds sealed blobs |
| [Arena](../services/arena) and [site](../web) | Our servers | Nothing. Attempt pages check claims against the chain |

## One payment, end to end

```text
agent            guard SDK              invoice store     vault contract               OutLayer TEE          NEAR AI (TEE)
  │ pay(invoice) ──►│                        │                  │                            │                     │
  │                 │ hash the invoice       │                  │                            │                     │
  │                 │ seal invoice+purpose ─►│ sealed blob      │                            │                     │
  │                 │ request_payment(mandate, payee, amount, invoice_hash, blob_ref) ─────►│                     │
  │                 │                        │                  │ contract rules             │                     │
  │                 │                        │                  │  fail ─► BLOCK, reason     │                     │
  │                 │                        │                  │  pass ─► reserve budget    │                     │
  │                 │                        │                  │ request_execution ────────►│ fetch blob          │
  │                 │                        │◄───────────────────────────────────────────────┤ decrypt, check hashes│
  │                 │                        │                  │                            │ ask the model ─────►│
  │                 │                        │                  │                            │ compare in code ◄───┤
  │                 │                        │                  │◄─ verdict (yield/resume) ──┤                     │
  │                 │                        │                  │ ALLOW ─► transfer to payee │                     │
  │                 │                        │                  │ WARN, none ─► park for owner                     │
  │                 │                        │                  │ BLOCK ─► release budget    │                     │
  │◄── result: paid / parked / refused, reason, layer, tx hash ─┤                            │                     │
```

1. **The SDK hashes the original invoice text.** That hash is what replay protection uses, so the agent should pass the document it received, not its model's retyping.
2. **The SDK seals the invoice, the purpose text and its salt** to the checker's X25519 public key (HKDF-SHA256, ChaCha20-Poly1305), and stores the sealed blob. Only the checker's private key, an OutLayer secret, opens it.
3. **The agent's function-call key calls `request_payment`.** The contract checks the mandate's status, the exact payee, the per-payment, total and daily limits, and replay, in [this order](MANDATES.md#contract-rules). A failure ends the request there with `BLOCK` and a reason code. On success it reserves the amount, so two racing requests can't both spend it.
4. **The vault asks OutLayer to run the checker** at the WASM URL and SHA-256 fixed when the vault was deployed. The fee comes from the mandate's checker budget, which the owner funds, because a function-call key can't attach a deposit. OutLayer holds the call open with yield/resume.
5. **The checker, inside the TEE,** fetches the blob (only an opaque ID under one configured URL), decrypts it, and checks that the invoice and purpose match the on-chain hashes. It refuses text that imitates message fields and parks text with hidden characters, before any model reads it. Then it asks the model to extract facts from the invoice, and **compares them with the payment in code**: payee, amount and whether it fits the purpose. The model never sees the requested payment, so it can't be talked into agreeing with it.
6. **The vault's callback applies the verdict.** Only an exact `ALLOW` pays, and only to the payee and amount the rules already checked. `WARN`, a timeout, an error or malformed output parks the payment for the owner. `BLOCK` releases the reserved budget. Every step logs a `payment_decided` event, and a transfer logs `payment_settled`.

## What is where

| Data | On-chain | Off-chain |
| --- | --- | --- |
| Payees, limits, expiry | Mandate, in clear | |
| Purpose text | `sha256(salt ‖ purpose)` | Sealed in each blob, and with the owner |
| Invoice text | `sha256(invoice)` | Sealed blob in the invoice store |
| Amount, payee, verdict, reasons | Request and events, in clear | |
| Checker's private key, NEAR AI key | | OutLayer secrets, only for our agent through the vault |

## Three ways to run the attacks

The same attack files run against three worlds, and the results are compared:

| Mode | Contract | Checker | Model | Needs |
| --- | --- | --- | --- | --- |
| Mock | Real vault WASM on a TypeScript NEAR runtime ([runtime.ts](../attacks/src/runtime.ts)) | Real checker logic, compiled to WASM | A stand-in that does what each attack needs | Nothing |
| Local node | Real vault on a NEAR sandbox node, real keys and yield/resume | Same | Same | The sandbox binary that `make test-contracts` downloads |
| Testnet | The deployed vault | The deployed checker in OutLayer | The real model | Keys and a little testnet NEAR |

Mock mode doesn't model gas or storage staking. The sandbox tests cover those.

## Deployment

The vault is deployed with its checker settings fixed: OutLayer's account, the checker's URL and hash, the fee, the resource limits and the timeout. There is no admin method to change them. Locking the vault, by deleting its full-access keys, makes that permanent. Steps are in [DEPLOY.md](DEPLOY.md).

The hosted parts run on Render's free plan, from [render.yaml](../render.yaml): the invoice store, the arena's server and the static site.
