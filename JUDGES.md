# For judges

Proving Ground puts an AI agent's payments behind a mandate its owner signs, enforced by a NEAR contract. The agent can be fully jailbroken and the money still only goes where the owner allowed. The model in the loop can only say no.

## 1. Run it (no keys needed)

Prerequisites: Rust (the pinned 1.95.0 installs itself through `rustup`), cargo-near 0.22.0, Node.js 24, and optionally Wasmtime 27. The [README](README.md#prerequisites) has the install commands.

```bash
make verify
```

It ends with:

```text
25 attacks stopped, 0 funds lost
```

That line comes from running all 25 attacks against the real vault WASM with an agent that always obeys the attacker. Before it, `make verify` lints, runs the contract's unit and sandbox tests, runs the checker's tests, and runs all 25 attacks on a local NEAR node to confirm every result matches.

## 2. Three things to try live

1. **Jailbreak the agent.** Open the [arena](https://provingground-web.onrender.com/arena) and try to talk the treasury agent into paying you. It uses a model with its refusals removed, so it often agrees. The contract still refuses, and the panel shows the reason code and the testnet transaction. The arena server sleeps when idle: allow a minute for the first attack.
2. **Forge a result.** Click "Share this attempt", open the link, then edit it to claim the payment went through. The page checks the claim against the transaction and says **Does not match the chain**.
3. **Read the chain.** The [README's attack table](README.md#attack-suite) links the testnet transaction for each attack. An [honest payment](https://testnet.nearblocks.io/txns/BzzHg9tu9scMYH7YcJPHaUZvyB2wtRp6onckPtdK4328) shows the full path: contract rules pass, OutLayer runs the checker, the checker allows it, the transfer settles.

## 3. Where each track is met

### AI Security & Defense (security)

| What | Where |
| --- | --- |
| Payments enforced by a contract, not by the model | [contracts/vault/src/lib.rs](contracts/vault/src/lib.rs) (`request_payment`), rules in [contracts/core](contracts/core) |
| Every rule and reason code | [docs/MANDATES.md](docs/MANDATES.md) |
| The checker can only refuse | `on_verdict` in [contracts/vault/src/lib.rs](contracts/vault/src/lib.rs). Attacks A19 and A20 test it |
| Threat model with honest limits | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) |
| 25 attacks, including Freysa's function confusion, look-alike payees, replay, races and injection aimed at the checker | [attacks/src/attacks](attacks/src/attacks), results in [attacks/report.json](attacks/report.json) |
| The same attacks with real transactions on testnet, 0 lost | [attacks/report.testnet.json](attacks/report.testnet.json) |
| Attempt links that can't be forged | [web/src/lib/attempt.ts](web/src/lib/attempt.ts), tested in [web/test/attempt.test.ts](web/test/attempt.test.ts) |
| A bounty for funds leaving outside a mandate | [docs/BOUNTY.md](docs/BOUNTY.md) |

### Agent Economy (agents)

| What | Where |
| --- | --- |
| A treasury agent that pays invoices through the guard | [agent/src/agent.ts](agent/src/agent.ts) |
| An SDK that puts any agent's payments behind a mandate | [packages/guard](packages/guard) |
| A CLI that tests other teams' agents, and our agent's own result (tried to pay on 14 of 16 attacks, all refused by the mandate) | [attacks/src/cli.ts](attacks/src/cli.ts), [attacks/report.demo-agent.json](attacks/report.demo-agent.json) |
| The agent's key can't move money itself | A function-call key for `request_payment` only. See A15 |
| Leaderboard and badge for tested agents | [leaderboard](https://provingground-web.onrender.com/leaderboard) |

### Privacy & Private AI (privacy)

| What | Where |
| --- | --- |
| Invoices are sealed to the checker's key, never on-chain | [packages/guard/src/seal.ts](packages/guard/src/seal.ts) and [services/checker/src/envelope.rs](services/checker/src/envelope.rs) (X25519, HKDF, ChaCha20-Poly1305) |
| Decrypted only inside OutLayer's TEE, by a checker pinned to its WASM hash | [services/checker](services/checker), hash in [deployments/testnet.json](deployments/testnet.json) |
| The checker's model runs in a TEE on NEAR AI Cloud | [services/checker/src/lib.rs](services/checker/src/lib.rs) |
| Keys held as OutLayer secrets, usable only by our agent through the vault | [scripts/testnet-secrets.sh](scripts/testnet-secrets.sh) |
| The mandate's purpose is stored as a salted hash | [docs/MANDATES.md](docs/MANDATES.md#data-structures) |
| What stays public, stated plainly | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md#limits), item 8 |

## 4. What isn't done

- **The testnet vault isn't locked yet.** Its account and the agent's still have full-access keys. Locking is the last step in [DEPLOY.md](docs/DEPLOY.md#8-lock-the-vault).
- **The contract is unaudited.**
- **Three attacks (A19, A20, A23) need control of the checker,** so they run in mock mode and on a local node, but not on testnet.
- **The checker's eval is small:** 32 cases that also shaped its prompt.
