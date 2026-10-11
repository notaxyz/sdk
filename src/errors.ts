export type NotaErrorCode =
  | "invalid_argument"
  | "invalid_link"
  | "unsupported_chain"
  | "deployment_mismatch"
  | "listing_not_found"
  | "listing_inactive"
  | "not_listing_seller"
  | "not_payable"
  | "insufficient_balance"
  | "purchases_paused"
  | "purchase_ref_blocked"
  | "receipt_mismatch"
  | "timeout"
  | "transaction_failed"
  | "unexpected_revert";

export class NotaError extends Error {
  readonly code: NotaErrorCode;
  /** Extra structured context, such as the request status that caused a refusal. */
  readonly details?: Record<string, unknown>;

  constructor(code: NotaErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NotaError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isNotaError(error: unknown, code?: NotaErrorCode): error is NotaError {
  return error instanceof NotaError && (code === undefined || error.code === code);
}
