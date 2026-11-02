# Threat model

Proving Ground treats the AI as untrusted. The question this document answers is: if everything on the agent's side is under an attacker's control, what can still happen to the money?

**Short answer:** vault funds can only go to a payee the owner listed, within the limits the owner set, or back to the owner. A fully compromised agent or checker cannot change that. They can still cause a bad payment to a listed payee, within those limits, and they can waste fees and block payments.

**Status:** the contract is implemented, and the defenses below that it enforces have tests against a mock of OutLayer. The checker has run as a real WASM against the live model. Nothing has run on testnet or inside the real OutLayer yet. Items that depend on that are marked *(pending live test)*.

Rules and reason codes are defined in [MANDATES.md](MANDATES.md).

## Assets

| Asset | Where it lives | Worst case |
| --- | --- | --- |
| Vault funds | Vault contract, per mandate | Stolen |
| Checker budget | Vault contract, per mandate | Burned on pointless checks |
| Storage prepayment | Vault contract, per mandate | Used up, blocking new requests |
| Agent gas | Agent account, function-call key allowance | Runs out, stopping the agent |
| Invoice and purpose text | Sealed to the checker off-chain; plaintext only in the checker TEE and NEAR AI's enclaves | Exposed |
| NEAR AI API key | Checker secret *(pending live test)* and hosted backend | Credits burned |
| Owner key | Owner's wallet | Everything the owner controls (out of scope) |
| Vault deployment key | Deployer | Everything in the vault, until the key is removed |

## Actors

| Actor | Controls | Goal |
| --- | --- | --- |
| Malicious user | Prompts sent to the agent | Get the agent to pay them |
| Poisoned invoice author | Invoice text the agent and checker read | Same, indirectly |
| Compromised agent | The agent's key and all its decisions | Move funds out |
| Compromised checker | The checker's output | Approve bad payments |
| Malicious vendor | A listed payee account | Overcharge, or bill twice |
| Front-runner | Transaction timing | Take or block a payment |
| Our own backend | Arena server, encrypted invoice storage, keys it holds | Anything above |

## Trust boundaries

```text
 untrusted                         │ enforced by the contract
 ─────────                         │ ────────────────────────
 user prompts ─┐                   │
 invoices ─────┼─► agent ─ request_payment ─► contract rules ─► vault
 tool output ──┘   (LLM)           │             ▲
                                   │             │ can only refuse
 ──────────────────────────────────┼─────────────┤
 trusted only to say no            │             │
 checker WASM ─► NEAR AI model ────┼─── verdict ─┘
 (TEE)           (TEE)             │
                                   │
 trusted fully: owner key, NEAR protocol, the vault code itself
```

## Every way money can leave

These are all of the paths. The contract should have no others, and the tests and the bounty both exist to check that.

| # | Path | Required | Bound |
| --- | --- | --- | --- |
| 1 | Payout after `ALLOW` | Contract rules pass, then an exact `ALLOW` | Listed payee, all limits |
| 2 | Payout after `approve` | Contract rules pass, then the owner's signature | Listed payee, all limits |
| 3 | `withdraw` / `close` | Owner's signature | Only to the owner |
| 4 | Checker fee to OutLayer *(pending live test)* | A request that passes the contract rules | `checker_budget`, `max_checks_per_day` |
| 5 | Redeploying the contract | **The vault account's full-access key** | **None. See below.** |
| 6 | Bug in the contract | Unknown | Unknown. See "Limits". |

### Path 5 needs an operational fix

Whoever holds a full-access key on the vault account can deploy new code and take everything, whatever the rules say. Removing all full-access keys after deployment locks the contract, and the contract has no method that adds keys. Anyone can confirm this with `view_access_key_list`.

- The deployment that holds the bounty is locked before the bounty opens.
- Locked means no upgrades. A fix ships as a new deployment that owners move to on their own.
- A testnet demo that still has a key must say so.

## Actors against defenses

The final column shows the worst result if that actor succeeds at everything within their power.

| Actor | Attempt | Stopped by | Worst result |
| --- | --- | --- | --- |
| Malicious user | Jailbreak into paying an attacker | Rule 9 `PAYEE_NOT_ALLOWED` | Nothing leaves |
| Malicious user | Talk the agent into overpaying a real vendor | Rules 10, 11, 14, then the checker | Listed payee, within limits |
| Poisoned invoice | Hidden instructions change the payee | Rule 9 | Nothing leaves |
| Poisoned invoice | Instructions aimed at the checker | Checker can only refuse; rules already ran; model never sees the payment, and code compares what it extracts | Same as a compromised checker |
| Poisoned invoice | Text posing as other message fields, or invisible text | Refused or parked before the model reads it | Payment refused or waits |
| Poisoned invoice | Fools the model into extracting the wrong facts | **Not fully stopped.** The contract's limits still apply | Listed payee, within limits |
| Compromised agent | Direct transfer | Function-call key cannot send NEAR | Nothing leaves |
| Compromised agent | Call owner methods | Key's `method_names`, 1 yocto check, owner check | Nothing leaves |
| Compromised agent | Add a key to the agent account | Function-call key cannot add keys | Nothing changes |
| Compromised agent | Use mandate A's budget for mandate B's payee | Rule 9 checks against that mandate only | Nothing leaves |
| Compromised agent | Use someone else's mandate | Rule 5 `NOT_AGENT` | Nothing leaves |
| Compromised agent | Split a large amount | Rules 11 and 14 | Listed payee, within limits |
| Compromised agent | Race two payments | Budget reserved synchronously, rule 11 | Second one refused |
| Compromised agent | Replay a paid invoice | Rule 15 `REPLAY` | Refused |
| Compromised agent | Change one byte and resubmit | **Not stopped by rule 15.** Limits, then the checker | Listed payee, within limits |
| Compromised agent | Re-submit until the model agrees | Hash stays burned, `CHECK_LIMIT` | Fees burned, bounded |
| Compromised agent | Burn checker budget | `max_checks_per_day`, `checker_budget` | Budget lost, then requests stop |
| Compromised agent | Spam refused requests | Agent pays its own gas; no state stored | Agent's allowance runs out |
| Compromised agent | Claim a refund to a new address | No refund path exists; only payees or the owner | Nothing leaves |
| Compromised agent | Attach too little gas to strand a request | `GAS_TOO_LOW` before anything is stored | Refused |
| Compromised agent | Oversized or garbled input | Rules 1–3 return a code without panicking. A wrong JSON type fails the transaction with no state change | Refused |
| Compromised checker | `ALLOW` everything | Runs only after the rules; cannot change payee or amount | Listed payee, within limits |
| Compromised checker | Garbage, or no answer | Parked, never paid | Payments wait |
| Malicious vendor | Bill too much or bill twice | Limits, checker, exact replay | **Can succeed within limits.** See "Limits" |
| Fake token contract | Credit a mandate by calling `ft_on_transfer` | Caller must equal `mandate.token` | Refused |
| Stranger | Use up a victim's daily cap | Cap is keyed by owner, not just agent | No effect on the victim |
| Malicious token owner | List a fake token on their own mandate | Balances are per mandate and token, so it only affects that mandate | No effect on others |
| Stranger | Call the callback directly | Callbacks are private | Refused |
| Stranger | `release_stale` too early | Deadline check; only moves funds into the mandate | Refused |
| Front-runner | Take or redirect a payment | Payee is fixed in the request; only the agent can call | Nothing to take |
| Front-runner | Burn an invoice hash first | Hashes are per owner and only that owner's agents write them | No effect |
| Our backend | Use its agent key | Same as compromised agent | Same bound |
| Our backend | Swap the stored invoice | Checker's hash check fails, nothing is paid | That request is refused |
| Compromised agent | Point `blob_ref` at its own server | Only a plain ID under the configured base URL is accepted | Refused |
| Compromised agent | Read another agent's invoices | Blobs are sealed to the checker's key; agents only hold the public key | Nothing readable |
| Our backend | Withhold the invoice | Parked as `CHECKER_UNAVAILABLE` | Payments wait |

The look-alike cases are handled in [MANDATES.md](MANDATES.md#contract-rules): homoglyphs fail as invalid account IDs, and typo-squats and sub-accounts fail exact matching.

## The function-call key

| It cannot | It can |
| --- | --- |
| Transfer NEAR | Call `request_payment` on the vault |
| Attach any deposit | Spend its gas allowance |
| Add or remove keys | Be stolen. A thief then has what a compromised agent has |
| Call any other contract or method | |

This holds only if the agent account has no full-access key. The demo agent's account will have only this key, and the setup will check that.

**Allowance is a real tradeoff.** NEAR's docs say a key with a set allowance stops working when it runs out, and adding funds to the account does not help. Leaving it unset removes that stop, but lets a compromised agent spend the account's whole balance on gas. We set an allowance and keep little NEAR on the agent account: running out stops the agent, it does not touch the vault, and the owner can issue a new key.

## Limits

These are not fully solved, and the README must say so.

1. **A listed payee that is itself malicious.** If the owner lists a vendor, the system can pay that vendor up to the limits. Mandates limit how much trust is extended. They do not establish that a vendor deserves it.
2. **Edited duplicates.** Replay protection matches exact bytes. An edited copy of a paid invoice gets through if the checker misses it, up to the limits. This is the most likely real loss, and it stays bounded by `max_total` and the daily cap.
3. **The checker is a model.** It can be fooled in both directions. It adds a chance of stopping bad payments inside the limits and no guarantee. Its eval is 32 cases that also shaped its prompt, so it is a regression check and not a measure of accuracy.
4. **Checker downtime.** Payments wait for the owner, and nothing is auto-approved. This favors safety over availability, so a long outage stops automated payments.
5. **Parked requests can hold up a budget.** A compromised agent can tie up budget with parked requests until `park_ttl` passes or the owner rejects them. Nothing is lost, but legitimate payments can be delayed.
6. **Fees are not vault funds.** A compromised agent can burn the checker budget and its own gas. The attack suite's "funds lost" counts vault funds, and will report checker fees burned as a separate number so the headline stays honest.
7. **Daily cap boundary.** Days are UTC buckets, so up to twice the cap can move across midnight.
8. **Metadata is public.** Mandate limits, payees, amounts, timing, hashes and verdict codes are all visible on-chain. Only invoice and purpose text are private. An exact invoice can be confirmed against its unsalted hash by anyone who can guess its contents.
9. **Trust in TEEs and OutLayer** *(pending live test)*. We rely on Intel TDX, the OutLayer contract and its worker allowlist. If they fail, the checker is compromised, which is the bound above. If they leak, invoice text is exposed. Funds outside the mandate remain safe.
10. **Trust in the model's evidence.** NEAR AI's docs say gateway evidence plus one response signature do not yet form a complete chain from model to final response, and instances of a model share one signing key. The checker also does not verify the response signature at run time; it trusts its TLS connection to the gateway. Verdicts are therefore not stronger evidence than that.
11. **Contract bugs.** The contract is unaudited. Tests and the public bounty reduce this risk, but do not remove it.
12. **Owner key compromise** is out of scope, along with an owner being tricked into signing a bad mandate. The owner defines what is authorized, so a stolen owner key is authorized by definition.
13. **No upgrades once locked.** A bug in a locked vault can only be fixed by owners withdrawing and moving to a new deployment. A bug that blocks `withdraw` itself would trap funds.
