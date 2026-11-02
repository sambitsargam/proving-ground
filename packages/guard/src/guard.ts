import { hashInvoice, seal, sha256Hex } from "./seal.ts";

const YOCTO_DECIMALS = 24;
const NEAR_AMOUNT = /^\d+(\.\d{1,24})?$/;

/** Converts a NEAR amount such as "12.5" to the exact yoctoNEAR string the vault takes. */
export function near(amount: string): string {
  if (!NEAR_AMOUNT.test(amount)) throw new Error(`not a NEAR amount: ${amount}`);
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole + fraction.padEnd(YOCTO_DECIMALS, "0")).toString();
}

export interface PaymentArgs {
  mandate_id: string;
  payee: string;
  amount: string;
  invoice_hash: string;
  blob_ref: string;
  memo: string;
}

export type Layer = "key" | "contract" | "checker" | "owner";

/** One NEP-297 `provingground` event from the vault's logs. */
export interface VaultEvent {
  event: string;
  data: Record<string, unknown>;
}

/** What the chain said. A refusal is a normal answer, so only transport errors throw. */
export interface VaultOutcome {
  decision: string;
  reason: string;
  mandateId: string | null;
  requestId: string | null;
  events: VaultEvent[];
  txHash?: string;
}

export interface VaultClient {
  requestPayment(args: PaymentArgs): Promise<VaultOutcome>;
}

export interface BlobStore {
  put(id: string, blob: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, string>();

  async put(id: string, blob: string): Promise<void> {
    this.blobs.set(id, blob);
  }
}

/** Stores blobs under a base URL with `PUT <base>/<id>`. The checker reads them with `GET`. */
export class HttpBlobStore implements BlobStore {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async put(id: string, blob: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${id}`, { method: "PUT", body: blob });
    if (!response.ok) throw new Error(`blob store refused the upload: HTTP ${response.status}`);
  }
}

/** The owner gives the agent these when granting a mandate. Their hash is on-chain. */
export interface MandateTerms {
  purpose: string;
  purposeSalt: string;
}

export interface GuardConfig {
  vault: VaultClient;
  blobs: BlobStore;
  checkerPublicKey: string;
  mandates: Record<string, MandateTerms>;
}

export interface PayRequest {
  mandateId: string;
  payee: string;
  /** yoctoNEAR, or the token's smallest unit. `near("12")` converts from NEAR. */
  amount: string;
  /** The invoice as text. It is sealed, and only its hash goes on-chain. */
  invoice: string;
  /** Public on-chain. */
  memo?: string;
}

export interface PayResult extends VaultOutcome {
  /** The money moved to the payee. */
  paid: boolean;
  /** The payment is waiting for the owner. */
  parked: boolean;
  /** The layer that made the final call. */
  layer: Layer;
  /** The checker's reasons, when it was the one that decided. */
  checkerReasons: string[];
}

function layerOf(outcome: VaultOutcome): { layer: Layer; checkerReasons: string[] } {
  const decided = outcome.events.filter((event) => event.event === "payment_decided").at(-1);
  const layer = decided?.data.layer;
  const reasons = decided?.data.checker_reasons;
  return {
    layer: layer === "checker" || layer === "owner" ? layer : "contract",
    checkerReasons: Array.isArray(reasons) ? reasons.map(String) : [],
  };
}

export function toPayResult(outcome: VaultOutcome): PayResult {
  return {
    ...outcome,
    ...layerOf(outcome),
    paid: outcome.decision === "PAID",
    parked: outcome.decision === "PARK",
  };
}

/**
 * Sends an agent's payments through the vault. Nothing here is a safety check: the
 * contract enforces the mandate, whatever this code or the agent does.
 */
export class Guard {
  private readonly config: GuardConfig;

  constructor(config: GuardConfig) {
    this.config = config;
  }

  async pay(request: PayRequest): Promise<PayResult> {
    const terms = this.config.mandates[request.mandateId];
    if (!terms) throw new Error(`no purpose text for mandate ${request.mandateId}`);
    const blob = seal({ invoice: request.invoice, ...terms }, this.config.checkerPublicKey);
    // Named by content, so a stored blob cannot be replaced by another under the same ID.
    const blobRef = sha256Hex(blob);
    await this.config.blobs.put(blobRef, blob);
    const outcome = await this.config.vault.requestPayment({
      mandate_id: request.mandateId,
      payee: request.payee,
      amount: request.amount,
      invoice_hash: hashInvoice(request.invoice),
      blob_ref: blobRef,
      memo: request.memo ?? "",
    });
    return toPayResult(outcome);
  }
}
