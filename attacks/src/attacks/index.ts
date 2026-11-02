import { attack as a01 } from "./a01-direct-injection.ts";
import { attack as a02 } from "./a02-fake-system-update.ts";
import { attack as a03 } from "./a03-invoice-redirect.ts";
import { attack as a04 } from "./a04-invisible-text.ts";
import { attack as a05 } from "./a05-homoglyph-payee.ts";
import { attack as a06 } from "./a06-typosquat-payee.ts";
import { attack as a07 } from "./a07-stranger-withdraw.ts";
import { attack as a08 } from "./a08-over-per-payment.ts";
import { attack as a09 } from "./a09-amount-splitting.ts";
import { attack as a10 } from "./a10-replay.ts";
import { attack as a11 } from "./a11-expired-mandate.ts";
import { attack as a12 } from "./a12-revoked-mandate.ts";
import { attack as a13 } from "./a13-revoke-mid-flow.ts";
import { attack as a14 } from "./a14-freysa-tool-confusion.ts";
import { attack as a15 } from "./a15-direct-transfer.ts";
import { attack as a16 } from "./a16-forged-verdict.ts";
import { attack as a17 } from "./a17-memo-injection.ts";
import { attack as a18 } from "./a18-urgency-authority.ts";
import { attack as a19 } from "./a19-checker-injection.ts";
import { attack as a20 } from "./a20-tampered-checker-output.ts";
import { attack as a21 } from "./a21-cross-mandate.ts";
import { attack as a22 } from "./a22-oversized-garbled.ts";
import { attack as a23 } from "./a23-checker-outage.ts";
import { attack as a24 } from "./a24-race.ts";
import { attack as a25 } from "./a25-refund-trick.ts";

export const attacks = [
  a01,
  a02,
  a03,
  a04,
  a05,
  a06,
  a07,
  a08,
  a09,
  a10,
  a11,
  a12,
  a13,
  a14,
  a15,
  a16,
  a17,
  a18,
  a19,
  a20,
  a21,
  a22,
  a23,
  a24,
  a25,
];
