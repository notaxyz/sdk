import { getAddress, isAddress, keccak256, stringToBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";

import type { NotaDeployment } from "./addresses.js";
import { canonicalize } from "./jcs.js";
import type { CheckoutMetadata, SignedReceiptQuote } from "./types.js";

export const CHECKOUT_METADATA_SCHEMA = "nota.checkout.metadata.v1";
/** Checkout Metadata v1's protocol version, independent of the EIP-712 domain version. */
export const CHECKOUT_METADATA_PROTOCOL_VERSION = "1";
export const DEFAULT_CHECKOUT_KIND = "payment_request";
export const MAX_PURPOSE_LENGTH = 500;
export const MAX_TITLE_LENGTH = 120;

const CHECKOUT_KIND_PATTERN = /^[a-z0-9][a-z0-9_:-]*$/;

/** keccak256 over the JCS-canonical document: the commitment the seller signs. */
export function hashCheckoutMetadata(document: CheckoutMetadata): Hex {
  return keccak256(stringToBytes(canonicalize(document)));
}

/** `listingHash` for `createListing`: keccak256 over the JCS-canonical listing document. */
export function hashListing(listing: Record<string, unknown>): Hex {
  if (listing === null || typeof listing !== "object" || Array.isArray(listing)) {
    throw new TypeError("listing must be a JSON object");
  }
  return keccak256(stringToBytes(canonicalize(listing)));
}

export function isValidCheckoutKind(kind: string): boolean {
  return kind.length >= 1 && kind.length <= 64 && CHECKOUT_KIND_PATTERN.test(kind);
}

export interface BuildCheckoutMetadataInput {
  deployment: NotaDeployment;
  seller: Address;
  listingHash: Hex;
  quote: Pick<SignedReceiptQuote, "listingId" | "buyer" | "purchaseRef" | "amount" | "issuedAt" | "expiresAt">;
  purpose: string;
  kind?: string;
}

/**
 * The purpose goes in `checkout.description` verbatim and, truncated to 120 characters, in
 * `checkout.title`. Addresses are EIP-55 checksummed and amounts are decimal strings, matching
 * the contracts repo's reference documents.
 */
export function buildCheckoutMetadata(input: BuildCheckoutMetadataInput): CheckoutMetadata {
  const { deployment, quote } = input;
  const title = Array.from(input.purpose).slice(0, MAX_TITLE_LENGTH).join("");
  return {
    schema: CHECKOUT_METADATA_SCHEMA,
    protocol: {
      name: "Nota",
      version: CHECKOUT_METADATA_PROTOCOL_VERSION,
      chainId: deployment.chainId,
      receiptStore: getAddress(deployment.store),
      settlementToken: getAddress(deployment.usdc),
    },
    seller: getAddress(input.seller),
    listing: {
      listingId: quote.listingId.toString(),
      listingHash: input.listingHash.toLowerCase() as Hex,
    },
    quote: {
      buyer: getAddress(quote.buyer),
      purchaseRef: quote.purchaseRef.toLowerCase() as Hex,
      amount: quote.amount.toString(),
      currency: "USDC",
      decimals: 6,
      issuedAt: Number(quote.issuedAt),
      expiresAt: Number(quote.expiresAt),
    },
    checkout: {
      kind: input.kind ?? DEFAULT_CHECKOUT_KIND,
      title,
      description: input.purpose,
    },
  };
}

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function sameHex(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every way the metadata document can disagree with the quote or the chain. An empty list means
 * the document is the one the quote commits to and describes this quote on this deployment.
 */
export function findMetadataProblems(
  metadata: unknown,
  quote: SignedReceiptQuote,
  deployment: NotaDeployment,
): string[] {
  if (!isObject(metadata)) return ["metadata is not an object"];

  const problems: string[] = [];
  let hash: Hex | undefined;
  try {
    hash = keccak256(stringToBytes(canonicalize(metadata)));
  } catch (error) {
    problems.push(`metadata cannot be canonicalized: ${(error as Error).message}`);
  }
  if (hash !== undefined && hash.toLowerCase() !== quote.metadataHash.toLowerCase()) {
    problems.push(`metadata hashes to ${hash}, but the signed quote commits to ${quote.metadataHash}`);
  }
  if (quote.metadataHash.toLowerCase() === zeroHash) problems.push("quote.metadataHash is zero");

  if (metadata.schema !== CHECKOUT_METADATA_SCHEMA) problems.push(`unsupported metadata schema: ${String(metadata.schema)}`);

  const protocol = isObject(metadata.protocol) ? metadata.protocol : {};
  if (protocol.chainId !== deployment.chainId) problems.push("metadata protocol.chainId does not match the chain");
  if (!sameAddress(protocol.receiptStore, deployment.store)) problems.push("metadata protocol.receiptStore is not the known store");
  if (!sameAddress(protocol.settlementToken, deployment.usdc)) problems.push("metadata protocol.settlementToken is not USDC");

  if (typeof metadata.seller !== "string" || !isAddress(metadata.seller, { strict: false }) || metadata.seller.toLowerCase() === zeroAddress) {
    problems.push("metadata seller is missing or not a valid address");
  }

  const listing = isObject(metadata.listing) ? metadata.listing : {};
  if (listing.listingId !== quote.listingId.toString()) problems.push("metadata listingId does not match the quote");
  if (typeof listing.listingHash !== "string") problems.push("metadata listingHash is missing");

  const q = isObject(metadata.quote) ? metadata.quote : {};
  if (q.amount !== quote.amount.toString()) problems.push("metadata amount does not match the quote");
  if (!sameHex(q.purchaseRef, quote.purchaseRef)) problems.push("metadata purchaseRef does not match the quote");
  if (!sameAddress(q.buyer, quote.buyer)) problems.push("metadata buyer does not match the quote");
  if (q.currency !== "USDC" || q.decimals !== 6) problems.push("metadata currency is not USDC with 6 decimals");
  if (q.issuedAt !== Number(quote.issuedAt)) problems.push("metadata issuedAt does not match the quote");
  if (q.expiresAt !== Number(quote.expiresAt)) problems.push("metadata expiresAt does not match the quote");

  const checkout = isObject(metadata.checkout) ? metadata.checkout : {};
  if (typeof checkout.title !== "string" || checkout.title.length === 0) problems.push("metadata checkout.title is missing");
  if (typeof checkout.kind !== "string" || !isValidCheckoutKind(checkout.kind)) problems.push("metadata checkout.kind is invalid");

  // Requests issued by this SDK are unbound and carry no integrator fee.
  if (quote.buyer.toLowerCase() !== zeroAddress) problems.push("quote is bound to a buyer; payment requests must be unbound");
  if (quote.integratorFeeAmount !== 0n || quote.integratorFeeRecipient.toLowerCase() !== zeroAddress) {
    problems.push("quote carries an integrator fee");
  }

  return problems;
}
