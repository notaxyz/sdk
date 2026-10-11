import { hashTypedData, type Address, type Hex } from "viem";

import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from "./addresses.js";
import type { SignedReceiptQuote } from "./types.js";

/**
 * Mirrors `NotaReceiptStore.SIGNED_RECEIPT_QUOTE_TYPEHASH` member for member. The store hashes
 * thirteen members: `seller`, `settlementToken` and `purchaseRefRegistry` are signed but are not
 * fields of the calldata struct (the contract takes them from the listing and its immutables).
 */
export const SIGNED_RECEIPT_QUOTE_TYPES = {
  SignedReceiptQuote: [
    { name: "listingId", type: "uint256" },
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "purchaseRef", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "metadataHash", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "settlementToken", type: "address" },
    { name: "purchaseRefRegistry", type: "address" },
    { name: "integratorFeeRecipient", type: "address" },
    { name: "integratorFeeAmount", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface QuoteSigningContext {
  chainId: number;
  store: Address;
  settlementToken: Address;
  purchaseRefRegistry: Address;
  seller: Address;
}

export function signedQuoteTypedData(quote: SignedReceiptQuote, context: QuoteSigningContext) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: context.chainId,
      verifyingContract: context.store,
    },
    types: SIGNED_RECEIPT_QUOTE_TYPES,
    primaryType: "SignedReceiptQuote",
    message: {
      listingId: quote.listingId,
      seller: context.seller,
      buyer: quote.buyer,
      purchaseRef: quote.purchaseRef,
      amount: quote.amount,
      metadataHash: quote.metadataHash,
      agentId: quote.agentId,
      settlementToken: context.settlementToken,
      purchaseRefRegistry: context.purchaseRefRegistry,
      integratorFeeRecipient: quote.integratorFeeRecipient,
      integratorFeeAmount: quote.integratorFeeAmount,
      issuedAt: quote.issuedAt,
      expiresAt: quote.expiresAt,
    },
  } as const;
}

/** The EIP-712 digest the seller signs. Byte-identical to the store's `hashSignedReceiptQuote`. */
export function quoteDigest(quote: SignedReceiptQuote, context: QuoteSigningContext): Hex {
  return hashTypedData(signedQuoteTypedData(quote, context));
}
