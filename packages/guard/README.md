# provingground-guard

Put an agent's payments behind a mandate on NEAR. The owner signs what the agent may pay, and the contract enforces it, whatever the agent has been talked into.

```ts
import { Guard, near } from "provingground-guard";
import { NearVault } from "provingground-guard/near";

const guard = new Guard({
  vault: new NearVault({ network: "testnet", vaultId, accountId, privateKey }),
  blobs,
  checkerPublicKey,
  mandates: { [mandateId]: { purpose, purposeSalt } },
});

const result = await guard.pay({ mandateId, payee, amount: near("12"), invoice });
```

`result.paid` says whether money moved, `result.parked` means the payment waits for the owner, and `result.reason` and `result.layer` say who decided and why. A refusal is a normal result, so `pay` only throws on transport errors.

The invoice is sealed to the checker's public key before it leaves your process. Only its hash goes on-chain.

**Hash the document, not the model's copy of it.** Pass the original invoice text to `pay`. If your model retypes the invoice, each version has a new hash and gets past replay protection.

The agent's key should be a function call key that can only call `request_payment` on the vault. This SDK is a convenience. The contract is what enforces the mandate.
