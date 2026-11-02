import { near } from "provingground-guard";

// One set of numbers for every mode, small enough for faucet accounts on testnet, so a
// result in mock mode can be compared directly with a result on a real chain.
export const PURPOSE = "Monthly web hosting from Acme Hosting, up to 0.15 NEAR a month.";
export const PAYROLL_PURPOSE = "Contractor payroll for the engineering team.";
export const DAILY_CAP = near("0.3");
export const MAX_TOTAL = near("0.5");
export const MAX_PER_PAYMENT = near("0.15");
export const FUNDING = near("0.5");
export const CHECKER_FEE = near("0.0105");
export const CHECKER_BUDGET = near("0.1");
export const MAX_REQUESTS = 10;
export const MAX_CHECKS_PER_DAY = 20;
export const DAY_NS = 86_400_000_000_000n;
/** Longer than the 200 block yield timeout, as MANDATES.md requires. */
export const CHECK_TIMEOUT_NS = 600_000_000_000n;
