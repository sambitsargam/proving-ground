export const VAULT = "provingground-vault.testnet";
export const AGENT = "provingground-agent.testnet";
export const VENDOR = "provingground-vendor.testnet";
export const REPO = "https://github.com/sambitsargam/proving-ground";
const RPC = "https://test.rpc.fastnear.com";
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const YOCTO = 10n ** 24n;

export function explorerUrl(txHash: string): string {
  return `${EXPLORER}${txHash}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…`;
}

export function nearText(yocto: string): string {
  let value: bigint;
  try {
    value = BigInt(yocto);
  } catch {
    return yocto;
  }
  const fraction = (value % YOCTO).toString().padStart(24, "0").replace(/0+$/, "").slice(0, 4);
  return `${value / YOCTO}${fraction ? `.${fraction}` : ""}`;
}

export interface DecidedEvent {
  payee?: string;
  decision?: string;
  reason?: string;
  layer?: string;
}

/** The vault's decision events for a transaction, read straight from a testnet RPC node. */
export async function decisionsOf(txHash: string): Promise<DecidedEvent[]> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tx",
      params: { tx_hash: txHash, sender_account_id: AGENT, wait_until: "NONE" },
    }),
  });
  const body = (await response.json()) as {
    result?: { receipts_outcome?: { outcome: { logs: string[] } }[] };
  };
  const logs = (body.result?.receipts_outcome ?? []).flatMap((receipt) => receipt.outcome.logs);
  return logs.flatMap((log) => {
    if (!log.startsWith("EVENT_JSON:")) return [];
    try {
      const event = JSON.parse(log.slice("EVENT_JSON:".length)) as {
        standard?: string;
        event?: string;
        data?: DecidedEvent[];
      };
      if (event.standard !== "provingground" || event.event !== "payment_decided") return [];
      return event.data ?? [];
    } catch {
      return [];
    }
  });
}
