import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const KDF_INFO = "provingground/checker/blob/v1";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The value `request_payment` takes as `invoice_hash`. */
export function hashInvoice(invoice: string): string {
  return sha256Hex(invoice);
}

export function newPurposeSalt(): string {
  return randomBytes(16).toString("hex");
}

/** The value `create_mandate` takes as `purpose_hash`. */
export function hashPurpose(purpose: string, purposeSalt: string): string {
  return sha256Hex(Buffer.concat([Buffer.from(purposeSalt, "hex"), Buffer.from(purpose)]));
}

export interface SealedContent {
  invoice: string;
  purpose: string;
  purposeSalt: string;
}

function publicKeyFromHex(hex: string) {
  if (!PUBLIC_KEY_HEX.test(hex)) throw new Error("checker public key must be 32 bytes of hex");
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}

/** Seals to the checker's public key. Format: services/checker/README.md. */
export function seal(content: SealedContent, checkerPublicKey: string): string {
  const recipient = publicKeyFromHex(checkerPublicKey);
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const epk = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const salt = Buffer.concat([epk, Buffer.from(checkerPublicKey, "hex")]);
  const shared = diffieHellman({ privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, salt, KDF_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const plaintext = JSON.stringify({
    invoice: content.invoice,
    purpose: content.purpose,
    purpose_salt: content.purposeSalt,
  });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    v: 1,
    epk: epk.toString("hex"),
    nonce: nonce.toString("hex"),
    ct: ct.toString("hex"),
  });
}
