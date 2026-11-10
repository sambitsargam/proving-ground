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
  amount?: string;
  /** Refused requests log only the amount's length in digits, not the amount. */
  amount_len?: number;
}

/** What one request_payment transaction did, as the chain recorded it. */
export interface ChainRecord {
  /** The vault's return value: the final decision, such as PAID, BLOCK or PARK. */
  result: { decision?: string; reason?: string } | null;
  /** Its payment_decided events, in order. */
  decided: DecidedEvent[];
}

function decodeResult(status: { SuccessValue?: string } | undefined): ChainRecord["result"] {
  if (!status?.SuccessValue) return null;
  try {
    const bytes = Uint8Array.from(atob(status.SuccessValue), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as ChainRecord["result"];
  } catch {
    return null;
  }
}

/** A transaction's outcome, read straight from a testnet RPC node. */
export async function chainRecordOf(txHash: string): Promise<ChainRecord> {
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
    result?: {
      status?: { SuccessValue?: string };
      receipts_outcome?: { outcome: { logs: string[] } }[];
    };
  };
  const logs = (body.result?.receipts_outcome ?? []).flatMap((receipt) => receipt.outcome.logs);
  const decided = logs.flatMap((log) => {
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
  return { result: decodeResult(body.result?.status), decided };
}
