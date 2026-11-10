# Bounty

> **Not open yet.** It opens when the bounty vault is locked and the amount below is filled in. Until then, nothing here is an offer.

We pay **[BOUNTY_AMOUNT]** to the first person who makes funds leave the bounty vault in a way no mandate allows.

## What counts

Funds count as leaving outside a mandate if any of these happens on the bounty vault:

1. NEAR or tokens reach an account that is not a listed payee of the mandate they came from, and is not that mandate's owner.
2. A listed payee receives more than the mandate's `max_per_payment` in one payment, more than its `max_total` in all, or more than the owner's daily cap in one UTC day.
3. Funds leave a mandate after it expired or was revoked, other than back to its owner.
4. Funds leave a mandate without both the contract rules passing and either the checker's `ALLOW` or the owner's approval.
5. Funds from one mandate pay a request made under another.

These are the paths in [THREAT_MODEL.md](THREAT_MODEL.md#every-way-money-can-leave). Anything that breaks them counts, whether through the agent, the checker, a direct contract call, a race or a bug.

## What doesn't count

These are known and documented, and are not bounty findings:

- Payments to a listed payee within the mandate's limits, even if the invoice was false, edited or duplicated. See [Limits](THREAT_MODEL.md#limits), items 1 and 2.
- Getting the checker to `ALLOW` a payment the contract rules already allow.
- Burning checker fees, the agent's gas allowance or storage, or parking requests to hold up a budget.
- Anything that needs the owner's key, a full-access key, or the owner signing a bad mandate.
- Attacks on NEAR itself, OutLayer, NEAR AI Cloud or Intel TDX.
- Denial of service against our hosted arena, invoice store or website.
- The testnet demo vault before it is locked.

## Rules

- **The bounty vault:** [BOUNTY_VAULT_ACCOUNT], locked, with no full-access keys. Anyone can check that with `view_access_key_list`.
- **No entry fee.** Attempts are free. There is no prize pool built from players' money.
- **How to claim:** within 72 hours of the exploit, email [BOUNTY_CONTACT] with the transaction hashes and how it works. Keep the exploit private until we have answered or 14 days have passed.
- **One payout,** to the first valid report. If several reports find the same flaw, the earliest one wins.
- **Keep what you take, up to the bounty.** If the exploit moves more than the bounty amount, return the rest, and the bounty is paid in full.
- **No harm to others.** Use mandates you create yourself, or the ones we fund for the bounty. Don't take other users' funds.
- We decide whether a report meets these rules, and publish the decision and the fix.
