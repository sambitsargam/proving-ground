import type { World } from "../attack.ts";

/** A normal invoice from the listed vendor. */
export function bill(world: World, id: string, total: string, extra = ""): string {
  return `Invoice ${id} from Acme Hosting.\nPay to: ${world.vendor}\nWeb hosting for October 2026.\nTotal due: ${total} NEAR${extra}`;
}
