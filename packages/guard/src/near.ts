import { Near, type PrivateKey, TransactionTimeoutError } from "near-kit";
import type { PaymentArgs, VaultClient, VaultEvent, VaultOutcome } from "./guard.ts";

const REQUEST_GAS = "300 Tgas";
const POLL_INTERVAL_MS = 2_000;
/** OutLayer answers within the 200 block yield window, about four minutes. */
const MAX_WAIT_MS = 300_000;

export interface NearVaultConfig {
  network: "testnet" | "mainnet";
  vaultId: string;
  accountId: string;
  /** The agent's function call key. It only has to be able to call `request_payment`. */
  privateKey: PrivateKey;
  rpcUrl?: string;
}

interface ChainOutcome {
  transaction?: { hash?: string };
  status?: unknown;
  receipts_outcome?: { outcome: { logs: string[] } }[];
}

export function eventsFromLogs(logs: string[]): VaultEvent[] {
  return logs.flatMap((log) => {
    if (!log.startsWith("EVENT_JSON:")) return [];
    try {
      const parsed = JSON.parse(log.slice("EVENT_JSON:".length)) as {
        standard?: string;
        event: string;
        data: Record<string, unknown>[];
      };
      if (parsed.standard !== "provingground") return [];
      return [{ event: parsed.event, data: parsed.data[0] ?? {} }];
    } catch {
      return [];
    }
  });
}

export function outcomeFromChain(result: ChainOutcome): VaultOutcome | null {
  const status = result.status as { SuccessValue?: string; Failure?: unknown } | undefined;
  if (status?.SuccessValue === undefined && status?.Failure === undefined) return null;
  const events = eventsFromLogs((result.receipts_outcome ?? []).flatMap((r) => r.outcome.logs));
  const txHash = result.transaction?.hash;
  const common = { events, ...(txHash ? { txHash } : {}) };
  if (status.SuccessValue === undefined) {
    return {
      decision: "PANIC",
      reason: "CALL_FAILED",
      mandateId: null,
      requestId: null,
      ...common,
    };
  }
  const value = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as {
    decision: string;
    reason: string;
    mandate_id: string | null;
    request_id: string | null;
  };
  return {
    decision: value.decision,
    reason: value.reason,
    mandateId: value.mandate_id,
    requestId: value.request_id,
    ...common,
  };
}

/** Sends payments to the deployed vault and waits for the whole flow to finish. */
export class NearVault implements VaultClient {
  private readonly near: Near;
  private readonly config: NearVaultConfig;

  constructor(config: NearVaultConfig) {
    this.config = config;
    this.near = new Near({
      network: config.network,
      privateKey: config.privateKey,
      defaultSignerId: config.accountId,
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    });
  }

  async requestPayment(args: PaymentArgs): Promise<VaultOutcome> {
    const { vaultId, accountId } = this.config;
    const sent = await this.near
      .transaction(accountId)
      .functionCall(vaultId, "request_payment", args, { gas: REQUEST_GAS })
      .send({ waitUntil: "INCLUDED" });
    const hash = sent.transaction?.hash;
    if (!hash) throw new Error("the RPC did not return a transaction hash");

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const status = await this.near.getTransactionStatus(hash, accountId, "EXECUTED");
        const outcome = outcomeFromChain(status as ChainOutcome);
        if (outcome) return outcome;
      } catch (error) {
        if (!(error instanceof TransactionTimeoutError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`transaction ${hash} did not finish in time`);
  }
}
