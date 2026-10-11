import type { Address, Hex } from "viem";

/** Calldata struct of `purchaseSignedReceipt`. Mirrors `NotaReceiptStore.SignedReceiptQuote`. */
export interface SignedReceiptQuote {
  listingId: bigint;
  /** Zero address: the quote is unbound and any wallet may pay it. */
  buyer: Address;
  purchaseRef: Hex;
  /** USDC base units (6 decimals). */
  amount: bigint;
  metadataHash: Hex;
  agentId: Hex;
  integratorFeeRecipient: Address;
  integratorFeeAmount: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
}

/** `nota.checkout.metadata.v1`, as documented in the contracts README. */
export interface CheckoutMetadata {
  schema: "nota.checkout.metadata.v1";
  protocol: {
    name: "Nota";
    version: "1";
    chainId: number;
    receiptStore: Address;
    settlementToken: Address;
  };
  seller: Address;
  listing: {
    listingId: string;
    listingHash: Hex;
  };
  quote: {
    buyer: Address;
    purchaseRef: Hex;
    amount: string;
    currency: "USDC";
    decimals: 6;
    issuedAt: number;
    expiresAt: number;
  };
  checkout: {
    kind: string;
    title: string;
    description?: string;
    externalOrderId?: string;
  };
}

/** A decoded payment request: everything a payer needs, carried in the link. */
export interface PaymentRequest {
  chainId: number;
  store: Address;
  quote: SignedReceiptQuote;
  signature: Hex;
  metadata: CheckoutMetadata;
  /**
   * Block to start the receipt log search from. Not covered by the signature: a wrong or
   * missing value can only make a paid request read as "blocked", never make anything read as
   * "paid".
   */
  fromBlock?: bigint;
}

export type RequestStatus =
  | "payable"
  | "paid"
  | "blocked"
  | "expired"
  | "wrong_chain"
  | "tampered"
  | "invalid_signature"
  | "listing_inactive"
  | "unknown_store";

export interface ReadRequestResult {
  status: RequestStatus;
  request: PaymentRequest;
  /** Present when status is "paid". */
  receipt?: NotaReceipt;
  /** Human-readable explanation for any status other than "payable". */
  reason?: string;
}

/** A verified `ReceiptPurchasedV2` log that matches a payment request. */
export interface NotaReceipt {
  chainId: number;
  store: Address;
  receiptId: bigint;
  seller: Address;
  /** The wallet that paid. Recorded on-chain as the receipt buyer. */
  payer: Address;
  listingId: bigint;
  purchaseRef: Hex;
  amount: bigint;
  metadataHash: Hex;
  agentId: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface CreateRequestResult extends PaymentRequest {
  url: string;
  purchaseRef: Hex;
  fromBlock: bigint;
}
