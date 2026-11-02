# Payment mandates

A mandate is what a human authorized, written down where the agent cannot change it. Every payment the vault makes must fit inside one.

The contract implements this spec, with tests against a mock of OutLayer that uses real yield/resume and follows OutLayer's published contract source. The path has not yet been run against the real OutLayer on testnet, so its gas figures and refund behavior are still to be confirmed there. The rules themselves do not depend on it.

## Data structures

```text
Mandate
  id                 u64
  owner              AccountId     caller of create_mandate; the only account that can manage it
  agent              AccountId     the only account that can call request_payment on it
  payees             [AccountId]   exact match only, at most 16
  token              Native | Ft(AccountId)
  max_total          u128          lifetime limit
  max_per_payment    u128
  purpose_hash       [u8; 32]      sha256(salt || purpose text); the text and salt stay off-chain
  expires_at         u64           nanoseconds
  max_requests       u32           lifetime limit on stored requests, prepaid at creation
  max_checks_per_day u32           limit on paid checker calls
  park_ttl           u64           how long a parked payment waits for the owner
  status             Active | Revoked | Closed   (expiry is derived from expires_at)

  balance            u128          funds held for this mandate, reserved funds included
  reserved           u128          held by requests in flight or parked
  spent              u128          paid out, never decreases
  checker_budget     u128          NEAR set aside for checker fees
  storage_balance    u128          NEAR prepaid for this mandate's storage
  requests_stored    u32           requests accepted so far
  checks_day, checks_today         daily count of paid checker calls

PaymentRequest
  id, mandate_id, payee, amount, invoice_hash, blob_ref, memo
  status, reason, created_at, updated_at

PaymentStatus
  Checking | Parked | Paying | Paid | Blocked | Rejected | Failed
```

The salt on `purpose_hash` stops anyone guessing a short purpose and confirming it against the public hash.

`invoice_hash` is unsalted, because a salt chosen by the agent would make replay protection meaningless. A low-entropy invoice can therefore be confirmed by someone who guesses its exact contents. Invoice contents themselves never go on-chain.

## Who can call what

| Method | Caller | Deposit | Effect |
| --- | --- | --- | --- |
| `set_daily_cap(agent, token, cap)` | owner | 1 yocto + storage | Sets the owner's daily limit for an agent and token |
| `create_mandate(...)` | owner | storage + checker budget | Creates an active mandate; native funding can come in the same call |
| `fund(mandate_id)` | owner | amount | Adds native NEAR |
| `ft_on_transfer(sender, amount, msg)` | token contract | none | Adds tokens; caller must equal `mandate.token` and sender must equal `mandate.owner` |
| `request_payment(...)` | agent | none | Runs the rules, then starts the checker |
| `approve(request_id)` | owner | 1 yocto | Pays a parked request after re-checking the mandate |
| `reject(request_id)` | owner | 1 yocto | Releases a parked request |
| `revoke(mandate_id)` | owner | 1 yocto | Permanently stops the mandate |
| `withdraw(mandate_id, amount)` | owner | 1 yocto | Returns unreserved funds to the owner |
| `close(mandate_id)` | owner | 1 yocto | Ends the mandate and refunds the unused checker budget and storage prepayment. Needs nothing in flight and a zero balance |
| `release_stale(request_id)` | anyone | none | Releases a request past its deadline; can only move funds back into the mandate |

The agent's key is a function-call key with `receiver_id` set to the vault and `method_names` set to `["request_payment"]`. It cannot attach a deposit, so it cannot pass the 1 yocto check on any owner method. All funds leaving the vault go to a mandate's payee or its owner. There is no admin role and no method that takes a destination from the caller.

### Why the daily cap belongs to the owner

Anyone can create a mandate naming any agent. A cap keyed only by agent would let a stranger use up a victim agent's daily allowance by spending through their own mandate. The cap is therefore keyed by `(owner, agent, token)`. If the owner has not set one, payment is blocked.

## Lifecycle

```text
create ──► fund ──► request_payment
                         │
                    contract rules ── fail ──► no state change, event + reason code
                         │ pass
                    reserve budget, burn invoice hash
                         │
                      Checking ── checker verdict
                         │
      ┌──────────────┬───┴───────────┬────────────────────┐
    ALLOW           WARN           BLOCK          timeout / error / bad output
      │              │               │                    │
      │              ▼               ▼                    ▼
      │           Parked          Blocked              Parked
      │        (owner decides)  (release budget,   (CHECKER_UNAVAILABLE,
      │         │        │       hash stays burned)  owner decides)
      │      approve   reject / park_ttl passes
      │         │        │
      │         │        ▼
      │         │     Rejected (release budget, hash stays burned)
      ▼         ▼
     Paying ── transfer callback ─ success ─► Paid (reserved → spent)
                  │
                failure ─► Failed (release budget, un-burn hash)
```

Revoke, expire, withdraw and close:

- **Revoke** takes effect immediately. A request still in `Checking` is refused when its verdict arrives, and parked requests can no longer be approved. A transfer already in `Paying` has left the contract's control and settles normally.
- **Expiry** is checked at request time, again when the verdict arrives, and again on approval. A mandate that expires during a check does not pay.
- **Withdraw** can take `balance - reserved` at any time, including after revoke or expiry.
- **Close** requires no requests in `Checking`, `Parked` or `Paying`, and a zero balance, so withdraw first. It refunds the unused checker budget and storage prepayment. Records already written, including replay records, stay on-chain and remain paid for. If the refund transfer fails, the amounts are restored and `close` can be called again.

## Contract rules

These run in this order, and the first failure decides. Every argument that can be malformed arrives as a plain string. A malformed value then returns a reason code and an event, not a deserialization panic. Arguments of the wrong JSON type, or missing ones, still fail the transaction before any rule runs. That changes no state and spends only the caller's gas.

Two checks come before rule 1:

| Check | Reason code |
| --- | --- |
| Prepaid gas covers every stage of the flow. Without this, a compromised agent could attach too little gas to strand a request | `GAS_TOO_LOW` |
| No deposit attached. Anything attached is returned | `DEPOSIT_NOT_ALLOWED` |

| # | Rule | Reason code |
| --- | --- | --- |
| 1 | Input lengths are within limits | `INPUT_TOO_LARGE` |
| 2 | Amount parses, is above zero | `AMOUNT_INVALID` |
| 3 | Invoice hash is 32 bytes of hex | `INVOICE_HASH_INVALID` |
| 4 | Mandate exists | `MANDATE_NOT_FOUND` |
| 5 | Caller is the mandate's agent | `NOT_AGENT` |
| 6 | Mandate is not revoked or closed | `MANDATE_REVOKED`, `MANDATE_CLOSED` |
| 7 | Mandate is not expired | `MANDATE_EXPIRED` |
| 8 | Payee is a valid account ID | `PAYEE_INVALID` |
| 9 | Payee exactly matches an allowed payee | `PAYEE_NOT_ALLOWED` |
| 10 | Amount is within `max_per_payment` | `OVER_PER_PAYMENT` |
| 11 | Amount fits `max_total - spent - reserved` | `OVER_TOTAL` |
| 12 | Amount fits `balance - reserved` | `INSUFFICIENT_BALANCE` |
| 13 | A daily cap is set for this owner, agent and token | `DAILY_CAP_UNSET` |
| 14 | Amount fits what is left of that cap today | `OVER_DAILY_CAP` |
| 15 | This owner has not used this invoice hash | `REPLAY` |
| 16 | Stored request count is below `max_requests` | `REQUEST_LIMIT` |
| 17 | Today's checks are below `max_checks_per_day` | `CHECK_LIMIT` |
| 18 | Checker budget covers one more check | `CHECKER_BUDGET_EXHAUSTED` |

A failure at this stage changes no state, so an attacker cannot make the vault store anything by sending bad requests. The only costs are the agent's own gas.

Unicode look-alikes never reach rule 9. NEAR account IDs are lowercase ASCII, so a homoglyph payee fails rule 8. A typo-squat such as `acme-pay.testnet` for `acmepay.testnet`, or a sub-account such as `pay.acme.testnet`, is a valid ID and fails rule 9. Only exact matches pass, and parent accounts grant nothing.

## Checker rules

The contract sends the checker the request ID, mandate ID, payee, amount, token, purpose hash, invoice hash and an opaque pointer to the encrypted invoice and purpose. `input_data` is public on-chain, so plaintext never goes in it.

The checker fetches and decrypts the pointer, and confirms both hashes match before calling the model. The model only copies facts out of the invoice, and code compares them with the payment. [services/checker](../services/checker/README.md) has the details. It must return exactly:

```json
{ "v": 1, "request_id": "42", "verdict": "ALLOW", "reasons": ["WITHIN_PURPOSE"] }
```

| Outcome | Result | Reason code |
| --- | --- | --- |
| `ALLOW` | Pay | `CHECKER_ALLOW` |
| `WARN` | Park for the owner | `CHECKER_WARN` |
| `BLOCK` | Refuse | `CHECKER_BLOCK` |
| Timeout, failed promise, or `null` (OutLayer's result for a failed run) | Park for the owner | `CHECKER_UNAVAILABLE` |
| Malformed or oversized output, wrong version, wrong request ID, any other verdict, extra fields | Park for the owner | `CHECKER_BAD_OUTPUT` |

`reasons` must come from a fixed list: `WITHIN_PURPOSE`, `OUT_OF_PURPOSE`, `AMOUNT_MISMATCH`, `PAYEE_MISMATCH`, `INJECTION_SUSPECTED`, `DUPLICATE_SUSPECTED`, `INVOICE_UNREADABLE`, `HASH_MISMATCH`, `UNCERTAIN`. Free text from the model could repeat invoice contents into public logs, so it stays off-chain. Anything other than an exact `ALLOW` never pays by itself.

**The model can only say no.** The checker runs only after the contract rules pass, and its callback has no way to change the payee or the amount. Those are read from the stored request.

## Verdict-time and approval-time rules

Limits can change between the request and the payout, so these are checked again when a verdict arrives and on approval.

| Rule | Reason code |
| --- | --- |
| Request is in the expected status | `BAD_REQUEST_STATE` |
| Mandate is not revoked or closed | `MANDATE_REVOKED`, `MANDATE_CLOSED` |
| Mandate is not expired | `MANDATE_EXPIRED` |
| Parked request is within `park_ttl` | `PARK_EXPIRED` |
| Caller is the mandate's owner (approval only) | `NOT_OWNER` |

Budget does not need re-checking, because it has been held by `reserved` since the request was accepted.

## Replay rules

An invoice hash is recorded per owner, so one invoice cannot be paid through two of the same owner's mandates. It is recorded when the contract rules pass.

| Final status | Hash | Why |
| --- | --- | --- |
| `Paid` | Stays burned | The invoice has been paid |
| `Blocked` | Stays burned | Stops re-submitting the same invoice until the model gives a different answer |
| `Rejected` | Stays burned | The owner said no |
| `Failed` | Released | The transfer failed, so a retry is legitimate |

An outage parks requests with their hash burned, so once one has expired or been rejected, the same bytes cannot be resubmitted. The owner approves it while parked, or the invoice is resubmitted as new bytes.

Replay protection works on exact bytes. An agent that changes one character gets a new hash. Such a copy still has to fit the payee list and every limit, and it costs a check. See "Limits" in the threat model.

## Budget invariants

These must hold after every state change, and the tests assert them:

```text
reserved + spent <= max_total
reserved <= balance
sum(native mandate balance + checker_budget + storage_balance) <= contract balance
sum(token mandate balance) <= contract's balance on that token
```

Because `reserved` is taken synchronously when a request is accepted, two requests racing for the last of a budget cannot both pass. The second fails rule 11.

## Failed transfers

The state moves to `Paying` before the transfer promise is created. A callback then settles the request:

- Success moves `amount` from `reserved` to `spent` and reduces `balance`.
- Failure releases `reserved`, keeps the balance and marks the request `Failed`. A native transfer to a missing account refunds to the vault, and an NEP-141 transfer to an unregistered account also fails, so the balance remains correct in both cases.

## Stuck requests

If a callback runs out of gas, a request can stay in `Checking` or `Paying`.

- A `Checking` request can be released by anyone with `release_stale` once it is past its deadline, which is longer than the yield timeout. A late verdict finds the wrong status and pays nothing.
- A `Paying` request is not released this way, because the transfer outcome is unknown and releasing it could double-spend the budget. Enough gas is reserved for that callback that this should not happen, and an integration test will cover it. If one is ever stuck, its budget stays held, which errs on the safe side.

## Checker fees

Each accepted request takes the fixed fee from `checker_budget` and attaches it to `request_execution`. OutLayer sends any unused part to `payer_account_id`, which is the mandate's owner. If OutLayer refuses the call outright, the fee returns to the vault and stays there unallocated, so the owner does not get it back. Token mandates also pay 1 yocto per check for `ft_transfer`.

## Deployment settings

The checker's source, version hash, fee and timeout are fixed at deployment, and there is no admin to change them. `check_timeout_ns` must be longer than the 200-block yield timeout, since `release_stale` lets anyone fail a request after that time. The vault's own code and base state need NEAR beyond what mandates hold, or transfers will fail with a storage error. Such a failure is safe, but payments stop until the vault is topped up.

## Storage

Each mandate prepays for its own record plus `max_requests` stored requests and replay records, at the current storage byte cost. The agent's key cannot attach a deposit, so storage cannot be paid at request time. Requests beyond `max_requests` are refused. This keeps one mandate from using storage that another owner paid for.

## Events

Every decision is logged as a NEP-297 event, including refusals:

```text
EVENT_JSON:{"standard":"provingground","version":"1.0.0","event":"payment_decided","data":[{
  "mandate_id":"7","request_id":"42","agent":"...","payee":"...","amount":"...",
  "invoice_hash":"...","layer":"checker","decision":"BLOCK","reason":"CHECKER_BLOCK",
  "checker_reasons":["OUT_OF_PURPOSE"]}]}
```

| Event | When |
| --- | --- |
| `mandate_created`, `mandate_funded`, `mandate_revoked`, `mandate_withdrawn`, `mandate_closed` | Mandate changes |
| `daily_cap_set` | Cap changes |
| `payment_decided` | Any rule or verdict decides |
| `payment_parked`, `payment_approved`, `payment_rejected` | Owner review |
| `payment_settled` | Transfer finished, either way |
| `call_refused` | An owner or funding call was refused |
| `mandate_withdraw_failed` | A withdrawal transfer failed and the balance was restored |

Refusals at the contract-rule stage have no `request_id`, because nothing is stored. Invalid payees and all amounts and memos on those refusals are logged by length only, so an attacker cannot use the logs to publish their payload.
