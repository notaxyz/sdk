import { getAddress, isAddress, type Address, type Hex } from "viem";

import { NotaError } from "./errors.js";
import type { CheckoutMetadata, PaymentRequest, SignedReceiptQuote } from "./types.js";

export const LINK_VERSION = 1;
export const DEFAULT_BASE_URL = "https://usenota.xyz/pay";
/** Fragment parameter carrying the payload. The fragment never reaches a server. */
export const LINK_PARAM = "r";

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_SIGNATURE_BYTES = 4096;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

/** JSON form of the link payload. bigint values are decimal strings. */
export interface LinkPayload {
  v: 1;
  chainId: number;
  store: Address;
  quote: {
    listingId: string;
    buyer: Address;
    purchaseRef: Hex;
    amount: string;
    metadataHash: Hex;
    agentId: Hex;
    integratorFeeRecipient: Address;
    integratorFeeAmount: string;
    issuedAt: string;
    expiresAt: string;
  };
  signature: Hex;
  metadata: CheckoutMetadata;
  fromBlock?: string;
}

export function toLinkPayload(request: PaymentRequest): LinkPayload {
  const { quote } = request;
  const payload: LinkPayload = {
    v: LINK_VERSION,
    chainId: request.chainId,
    store: request.store,
    quote: {
      listingId: quote.listingId.toString(),
      buyer: quote.buyer,
      purchaseRef: quote.purchaseRef,
      amount: quote.amount.toString(),
      metadataHash: quote.metadataHash,
      agentId: quote.agentId,
      integratorFeeRecipient: quote.integratorFeeRecipient,
      integratorFeeAmount: quote.integratorFeeAmount.toString(),
      issuedAt: quote.issuedAt.toString(),
      expiresAt: quote.expiresAt.toString(),
    },
    signature: request.signature,
    metadata: request.metadata,
  };
  if (request.fromBlock !== undefined) payload.fromBlock = request.fromBlock.toString();
  return payload;
}

/** `${baseUrl}#r=<base64url(JSON payload)>`. */
export function encodeRequest(request: PaymentRequest, baseUrl: string = DEFAULT_BASE_URL): string {
  if (baseUrl.includes("#")) {
    throw new NotaError("invalid_argument", "baseUrl must not contain a fragment");
  }
  // Round-trip through the strict parser so a link this function emits always decodes.
  const payload = parseLinkPayload(toLinkPayload(request));
  return `${baseUrl}#${LINK_PARAM}=${base64UrlEncode(JSON.stringify(payload))}`;
}

/**
 * Decode a payment link. Accepts a full URL, a fragment (`#r=...`), the bare base64url payload,
 * a `LinkPayload` object or a `PaymentRequest`. The result is shape-checked only: whether it is
 * genuine and payable is `readRequest`'s job.
 */
export function decodeRequest(input: string | LinkPayload | PaymentRequest): PaymentRequest {
  if (typeof input !== "string") {
    if (input === null || typeof input !== "object") throw invalid("payload must be a string or an object");
    if ("v" in input) return fromLinkPayload(parseLinkPayload(input));
    return fromLinkPayload(parseLinkPayload(toLinkPayloadLoose(input)));
  }

  const encoded = extractEncoded(input.trim());
  let json: string;
  try {
    json = base64UrlDecode(encoded);
  } catch (error) {
    throw invalid("payload is not valid base64url UTF-8", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw invalid("payload is not valid JSON", error);
  }
  return fromLinkPayload(parseLinkPayload(parsed));
}

function toLinkPayloadLoose(request: PaymentRequest): unknown {
  try {
    return toLinkPayload(request);
  } catch (error) {
    throw invalid("payment request object is malformed", error);
  }
}

function extractEncoded(input: string): string {
  const hashIndex = input.indexOf("#");
  const fragment = hashIndex >= 0 ? input.slice(hashIndex + 1) : input;
  if (hashIndex >= 0 || fragment.startsWith(`${LINK_PARAM}=`) || fragment.includes("&")) {
    const params = new URLSearchParams(fragment);
    const value = params.get(LINK_PARAM);
    if (value === null || value.length === 0) throw invalid(`link has no "${LINK_PARAM}" fragment parameter`);
    return value;
  }
  return fragment;
}

function fromLinkPayload(payload: LinkPayload): PaymentRequest {
  const q = payload.quote;
  const quote: SignedReceiptQuote = {
    listingId: BigInt(q.listingId),
    buyer: q.buyer,
    purchaseRef: q.purchaseRef,
    amount: BigInt(q.amount),
    metadataHash: q.metadataHash,
    agentId: q.agentId,
    integratorFeeRecipient: q.integratorFeeRecipient,
    integratorFeeAmount: BigInt(q.integratorFeeAmount),
    issuedAt: BigInt(q.issuedAt),
    expiresAt: BigInt(q.expiresAt),
  };
  const request: PaymentRequest = {
    chainId: payload.chainId,
    store: payload.store,
    quote,
    signature: payload.signature,
    metadata: payload.metadata,
  };
  if (payload.fromBlock !== undefined) request.fromBlock = BigInt(payload.fromBlock);
  return request;
}

const TOP_LEVEL_KEYS = new Set(["v", "chainId", "store", "quote", "signature", "metadata", "fromBlock"]);
const QUOTE_KEYS = [
  "listingId",
  "buyer",
  "purchaseRef",
  "amount",
  "metadataHash",
  "agentId",
  "integratorFeeRecipient",
  "integratorFeeAmount",
  "issuedAt",
  "expiresAt",
] as const;

/** Strict structural validation of an untrusted payload. Normalizes addresses and hex case. */
export function parseLinkPayload(value: unknown): LinkPayload {
  if (!isPlainObject(value)) throw invalid("payload must be a JSON object");
  if (value.v !== LINK_VERSION) throw invalid(`unsupported link version: ${JSON.stringify(value.v)}`);
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw invalid(`unknown payload field: ${key}`);
  }

  if (typeof value.chainId !== "number" || !Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
    throw invalid("chainId must be a positive integer");
  }

  const quote = value.quote;
  if (!isPlainObject(quote)) throw invalid("quote must be an object");
  const quoteKeys = Object.keys(quote);
  if (quoteKeys.length !== QUOTE_KEYS.length || !QUOTE_KEYS.every((key) => key in quote)) {
    throw invalid(`quote must have exactly the fields ${QUOTE_KEYS.join(", ")}`);
  }

  const metadata = value.metadata;
  if (!isPlainObject(metadata)) throw invalid("metadata must be an object");

  const signature = value.signature;
  if (typeof signature !== "string" || !HEX.test(signature) || (signature.length - 2) / 2 > MAX_SIGNATURE_BYTES) {
    throw invalid("signature must be non-empty hex");
  }

  const payload: LinkPayload = {
    v: LINK_VERSION,
    chainId: value.chainId,
    store: address(value.store, "store"),
    quote: {
      listingId: decimal(quote.listingId, "quote.listingId", MAX_UINT256),
      buyer: address(quote.buyer, "quote.buyer"),
      purchaseRef: bytes32(quote.purchaseRef, "quote.purchaseRef"),
      amount: decimal(quote.amount, "quote.amount", MAX_UINT256),
      metadataHash: bytes32(quote.metadataHash, "quote.metadataHash"),
      agentId: bytes32(quote.agentId, "quote.agentId"),
      integratorFeeRecipient: address(quote.integratorFeeRecipient, "quote.integratorFeeRecipient"),
      integratorFeeAmount: decimal(quote.integratorFeeAmount, "quote.integratorFeeAmount", MAX_UINT256),
      issuedAt: decimal(quote.issuedAt, "quote.issuedAt", MAX_UINT64),
      expiresAt: decimal(quote.expiresAt, "quote.expiresAt", MAX_UINT64),
    },
    signature: signature.toLowerCase() as Hex,
    metadata: metadata as unknown as CheckoutMetadata,
  };
  if (value.fromBlock !== undefined) payload.fromBlock = decimal(value.fromBlock, "fromBlock", MAX_UINT64);
  return payload;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw invalid(`${field} must be an address`);
  return getAddress(value);
}

function bytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !BYTES32.test(value)) throw invalid(`${field} must be 32 bytes of hex`);
  return value.toLowerCase() as Hex;
}

function decimal(value: unknown, field: string, max: bigint): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > max) {
    throw invalid(`${field} must be a decimal string`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string, cause?: unknown): NotaError {
  return new NotaError("invalid_link", `Invalid payment link: ${message}`, undefined, cause === undefined ? undefined : { cause });
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) throw new Error("not base64url");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encoded.length + 3) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
