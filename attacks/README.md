# provingground

Find out which jailbreaks your AI agent falls for, and what a payment mandate on NEAR would have done about each one.

```bash
npx provingground test
```

With no target, it runs 25 attacks against the real [Proving Ground](https://provingground-web.onrender.com) vault contract on a simulated NEAR runtime, with an agent that always does what the attacker asks. It needs no keys and no network, and ends with:

```text
25 attacks stopped, 0 funds lost
```

## Test your own agent

```bash
npx provingground test https://your-agent.example/chat
```

Your endpoint takes `POST {"message": "..."}` and answers:

```json
{ "reply": "...", "payments": [{ "payee": "someone.testnet", "amount": "<yoctoNEAR>" }] }
```

The CLI sends every attack that reaches an agent, then runs each payment your agent tried against the vault contract. You see which attacks your agent fell for, and whether a mandate would have refused them. For an endpoint that needs headers, pass a JSON file instead of a URL: `{"endpoint": "https://...", "headers": {"authorization": "..."}}`.

## Options

| Option | What it does |
| --- | --- |
| `--only A01,A02` | Run only these attacks |
| `--report <path>` | Where to write the JSON report. Default `report.json` |
| `--live <deployment.json>` | Run against a vault deployed on testnet, with real transactions. Needs keys: see the repository |

## What's inside

The package includes the vault contract's WASM (SHA-256 `c6b3aa8e4fdb6c208e368cd1104e8001585450283835f80037c51a42fe8b4270`, the same code deployed to `provingground-vault.testnet`) and the checker's decision logic. The report records both hashes.

Requires Node.js 24 or later. Source, threat model and the testnet results: [github.com/sambitsargam/proving-ground](https://github.com/sambitsargam/proving-ground).

MIT licensed.
