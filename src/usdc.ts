import { formatUnits, parseUnits } from "viem";

import { USDC_DECIMALS } from "./addresses.js";
import { NotaError } from "./errors.js";

/** "0.10" -> 100000n. Rejects more than 6 decimal places rather than rounding. */
export function parseUsdc(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value.trim())) {
    throw new NotaError("invalid_argument", `invalid USDC amount: ${JSON.stringify(value)} (up to 6 decimals)`);
  }
  return parseUnits(value.trim(), USDC_DECIMALS);
}

/** 100000n -> "0.1". */
export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}
