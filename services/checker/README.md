# Checker

The veto-only third layer. It runs after the contract rules have passed and answers `ALLOW`, `WARN` or `BLOCK`. It cannot change the payee or the amount, because the contract reads those from the stored request. **The model can only say no.**

It is a WASI program built for OutLayer: input on stdin, verdict on stdout, secrets in the environment.

**Status:** running in OutLayer on testnet for the deployed vault, with its keys delivered as OutLayer secrets. A check took about 2 seconds and cost 0.0013 NEAR, with the rest of the fee refunded. It is also tested as a WASM under Wasmtime 27 against the live NEAR AI model.

## What happens on a request

1. **Fetch** the sealed blob from `BLOB_BASE_URL/<blob_ref>`. The agent picks `blob_ref`, so only a plain ID is accepted and the fetch cannot be sent anywhere else.
2. **Open** it with the checker's private key.
3. **Compare hashes** with the on-chain `invoice_hash` and `purpose_hash`. A swapped invoice stops here.
4. **Screen the text.** Quoted field names from the model's message format are refused, and invisible characters send the payment to the owner. Neither reaches the model.
5. **Ask the model** to copy facts out of the invoice. It never sees the payment's payee or amount, so it cannot simply agree with them.
6. **Compare in code.** The model's opinion can only make the result stricter.

| Finding | Verdict | Reason |
| --- | --- | --- |
| Model says `BLOCK` | `BLOCK` | The model's reasons, from a fixed list |
| Invoice names a different valid account | `BLOCK` | `PAYEE_MISMATCH` |
| Same currency, different total | `BLOCK` | `AMOUNT_MISMATCH` |
| Hash mismatch | `BLOCK` | `HASH_MISMATCH` |
| Blob cannot be opened or is oversized | `BLOCK` | `INVOICE_UNREADABLE` |
| Text posing as message fields | `BLOCK` | `INJECTION_SUSPECTED` |
| Invisible characters | `WARN` | `INJECTION_SUSPECTED` |
| Payee, total or currency not confirmed; more than one amount due; line items do not add up; malformed model reply | `WARN` | `UNCERTAIN` |
| Every fact matches and the model says `ALLOW` | `ALLOW` | `WITHIN_PURPOSE` |

If the blob or the model is unavailable, the run exits non-zero with nothing on stdout. OutLayer reports `null`, and the contract parks the payment as `CHECKER_UNAVAILABLE`. Nothing is ever auto-approved.

Every output goes through the contract's own parser before it is printed.

## Sealed blob format

Agents seal to the checker's X25519 public key, so they can write blobs but cannot read each other's.

```text
plaintext  {"invoice": "...", "purpose": "...", "purpose_salt": "<hex>"}
shared     X25519(ephemeral private key, checker public key)
key        HKDF-SHA256(shared, salt = epk || checker public key,
                       info = "provingground/checker/blob/v1", 32 bytes)
ct         ChaCha20-Poly1305(key, nonce, plaintext), with the 16-byte tag appended
blob       {"v": 1, "epk": "<hex>", "nonce": "<hex>", "ct": "<hex>"}
```

- `invoice_hash` is `sha256(invoice as UTF-8)`.
- `purpose_hash` is `sha256(salt || purpose as UTF-8)`.
- The agent needs the purpose text and salt from the owner to seal a blob. If it lies about them, the hash check fails.

Invoices are text, up to 32 KiB. Other formats have to be converted first.

**Token mandates:** the checker knows NEAR's decimals but not a token's, so the owner states them on the first line of the purpose, which the hash covers: `token: USDC 6`. Without that line a token payment can be refused but never allowed, so it goes to the owner.

**A vendor's invoice must name its account and its total in the mandate's token.** Otherwise the payment goes to the owner. That is deliberate: the checker will not guess a conversion.

## Secrets

| Secret | Purpose |
| --- | --- |
| `NEAR_AI_API_KEY` | Model calls. Sent only to the model endpoint |
| `CHECKER_SECRET_KEY` | 32 bytes of hex. Opens sealed blobs |
| `BLOB_BASE_URL` | Where blobs live. The hash check covers a wrong or hostile host |

The model name, endpoint and prompt are compiled in, so the WASM hash the vault pins covers them. A different model or prompt is a new hash and a new vault deployment. The `local-model` feature that lets tests redirect the endpoint is off in release builds.

## Build and test

```bash
make checker
```

```bash
make test-checker
```

```bash
make checker-eval
```

`make test-checker` needs Wasmtime 27, the version OutLayer's worker uses, on the `PATH` or in `WASMTIME`. It does not compile on current stable Rust, so install it with an older toolchain:

```bash
cargo +1.82.0 install wasmtime-cli --version 27.0.0 --locked
```

`make checker-eval` runs the release WASM against the real model and spends a little credit.

## Model

`Qwen/Qwen3.6-35B-A3B-FP8` on NEAR AI Cloud, with reasoning off.

| Measured on Nov 2, 2026 | Result |
| --- | --- |
| Gateway and model quotes | DCAP `UpToDate`, bound to signer and fresh nonce |
| Response signature | `provider_tee`, valid over the exact request and response bytes, signer matches the verified preflight report |
| Time per check | Under 2 s typically, slowest seen 3.3 s, including WASM startup |
| Instructions | Completes at 10M with a scripted model. 5M was too few |

`Qwen/Qwen3.8-27B` was the first choice and is cheaper, but it was down during testing: completions hung or returned 502, and its attestation endpoint failed.

Turning reasoning on did not help. It used about 1,300 output tokens per check, took up to 8 s, and most answers ran out of the 1,500 token limit.

## How good is it?

`make checker-eval` runs 32 hostile and honest invoices. The last run gave the expected result on all 32, with no wrong `ALLOW` and no good invoice refused.

**Read that number with care.** The prompt and rules were adjusted using these same cases, and 32 cases are not a measure of real-world accuracy. Of eight cases added before the final changes, the six attacks were refused on the first try and the two honest invoices were wrongly parked until the prompt was fixed.

Earlier versions got wrong answers that shaped this design:

- With the payment amount in view, the model allowed a 9 NEAR invoice against a 12 NEAR payment. That is why the model no longer sees the amount and code does the comparing.
- It allowed an invoice saying "total 12, payable now 4". That is why any second amount due now stops an `ALLOW`.

## What this does and does not prove

- **The checker cannot widen what the contract allows.** That follows from the contract, not from this program.
- **The attestation and signature checks above were run separately.** The checker does not verify the response signature at run time. It trusts its TLS connection to NEAR AI's attested gateway.
- **The verdict is only as good as the model.** A clever invoice can still get an `ALLOW`, up to the mandate's limits, to a payee the owner listed.
- **Invoice text is visible to** the checker and to NEAR AI's gateway and model enclaves. It never goes on-chain.
