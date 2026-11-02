import { readFileSync } from "node:fs";
import { type ModelMode, standInModel } from "./model.ts";

const NO_VALUE = 0xffff_ffff_ffff_ffffn;
const NEAR_DECIMALS = 24;

export const wasmDir = new URL("../wasm/", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface AbiExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  check(input: number, len: number, key: number): bigint;
}

/** The whole amount as a plain decimal, such as "0.12". */
function decimalNear(yocto: string): string {
  let value = 0n;
  try {
    value = BigInt(yocto);
  } catch {
    return "0";
  }
  const text = value.toString().padStart(NEAR_DECIMALS + 1, "0");
  const whole = text.slice(0, -NEAR_DECIMALS);
  const fraction = text.slice(-NEAR_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The real checker logic, compiled for plain WASM, behind a stand-in model. OutLayer runs
 * the WASI build of the same code. Only where the invoice and the reply come from differs.
 */
export class CheckerLogic {
  modelMode: ModelMode = "honest";
  override: ((requestId: string) => string | null) | undefined;
  private readonly blobs: Map<string, string>;
  private readonly secretKey: Uint8Array;
  private readonly exports: AbiExports;
  private current = { payee: "", total: "0" };

  constructor(blobs: Map<string, string>, secretKey: Uint8Array) {
    this.blobs = blobs;
    this.secretKey = secretKey;
    const module = new WebAssembly.Module(readFileSync(new URL("checker.wasm", wasmDir)));
    const instance = new WebAssembly.Instance(module, {
      host: {
        host_get: (ptr: number, len: number) => {
          const id = this.readText(ptr, len).split("/").pop() ?? "";
          return this.toPacked(this.blobs.get(id) ?? null);
        },
        host_model: (ptr: number, len: number) =>
          this.toPacked(standInModel(this.readText(ptr, len), this.modelMode, this.current)),
      },
    });
    this.exports = instance.exports as unknown as AbiExports;
  }

  /** What OutLayer would return as the job's output. `null` is a failed run. */
  output(input: string): string | null {
    const parsed = JSON.parse(input) as { request_id: string; payee: string; amount: string };
    if (this.override) return this.override(parsed.request_id);
    this.current = { payee: parsed.payee, total: decimalNear(parsed.amount) };
    try {
      const inputBytes = encoder.encode(input);
      const inputPtr = this.exports.alloc(inputBytes.length);
      new Uint8Array(this.exports.memory.buffer).set(inputBytes, inputPtr);
      const keyPtr = this.exports.alloc(32);
      new Uint8Array(this.exports.memory.buffer).set(this.secretKey, keyPtr);
      const packed = BigInt.asUintN(64, this.exports.check(inputPtr, inputBytes.length, keyPtr));
      if (packed === NO_VALUE) return null;
      return this.readText(Number(packed >> 32n), Number(packed & 0xffff_ffffn));
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) return null;
      throw error;
    }
  }

  private readText(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len).slice());
  }

  private toPacked(text: string | null): bigint {
    if (text === null) return NO_VALUE;
    const bytes = encoder.encode(text);
    const ptr = this.exports.alloc(bytes.length);
    new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
    return (BigInt(ptr) << 32n) | BigInt(bytes.length);
  }
}
