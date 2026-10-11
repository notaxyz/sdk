import {
  toHex,
  zeroAddress,
  zeroHash,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { notaReceiptStoreAbi } from "./abi.js";
import { getDeployment, type NotaDeployment } from "./addresses.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { DEFAULT_BASE_URL, decodeRequest, encodeRequest } from "./link.js";
import {
  buildCheckoutMetadata,
  findMetadataProblems,
  hashCheckoutMetadata,
  isValidCheckoutKind,
  MAX_PURPOSE_LENGTH,
} from "./metadata.js";
import { assertRawPurchaseRef, hashPurchaseRef } from "./purchase-ref.js";
import { findMatchingReceipt, isPurchaseRefConsumed, type RequestInput } from "./receipt.js";
import { readListing, requireAccount, revertName, sameAddress } from "./chain.js";
import { signedQuoteTypedData } from "./typed-data.js";
import type { CreateRequestResult, PaymentRequest, ReadRequestResult, SignedReceiptQuote } from "./types.js";

/** `NotaReceiptStore.MIN_PURCHASE_AMOUNT`: 0.0001 USDC. */
export const MIN_AMOUNT = 100n;
/** `NotaReceiptStore.MAX_QUOTE_TTL`. */
export const MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60;
export const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export type CreateRequestParams = {
  publicClient: PublicClient;
  listingId: bigint | number | string;
  /** USDC base units (6 decimals). `parseUsdc("0.10")` gives 100000n. */
  amount: bigint;
  /** What the money is for. Stored in the signed checkout metadata, so do not put secrets or PII here. */
  purpose: string;
  /** 1 to 86400. Default 3600. */
  expiresInSeconds?: number;
  /** 32-byte hex agent identifier, seller-attested. Default zero (unspecified). */
  agentId?: Hex;
  /** Default `https://usenota.xyz/pay`. */
  baseUrl?: string;
  /** Business reference hashed into purchaseRef; 1 to 128 bytes. Default: a random `nota_request_...`. */
  rawPurchaseRef?: string;
  /** `checkout.kind`. Default `payment_request`. */
  kind?: string;
} & ({ walletClient: WalletClient; account?: undefined } | { account: Account; walletClient?: undefined });

function randomBytes32(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

function toListingId(value: bigint | number | string): bigint {
  try {
    const id = BigInt(value);
    if (id > 0n) return id;
  } catch {
    // fall through
  }
  throw new NotaError("invalid_argument", `listingId must be a positive integer, got ${String(value)}`);
}

/**
 * Sign an unbound payment request against a listing and encode it as a link. The signing account
 * must be the listing's seller or a quote signer the seller authorized for that listing; either
 * way the seller is paid.
 * Nothing is sent on-chain. The quote is checked with `validateSignedReceiptPurchase` before the
 * link is returned, so a link this function returns was payable when it was made.
 */
export async function createRequest(params: CreateRequestParams): Promise<CreateRequestResult> {
  const { publicClient } = params;
  const expiresInSeconds = params.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  const agentId = (params.agentId ?? zeroHash).toLowerCase() as Hex;
  const kind = params.kind ?? "payment_request";
  const listingId = toListingId(params.listingId);

  if (typeof params.amount !== "bigint") throw new NotaError("invalid_argument", "amount must be a bigint in USDC base units");
  if (params.amount < MIN_AMOUNT) {
    throw new NotaError("invalid_argument", `amount must be at least ${MIN_AMOUNT} base units (0.0001 USDC), got ${params.amount}`);
  }
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
    throw new NotaError("invalid_argument", `expiresInSeconds must be an integer from 1 to ${MAX_EXPIRES_IN_SECONDS}, got ${expiresInSeconds}`);
  }
  if (typeof params.purpose !== "string" || params.purpose.trim().length === 0) {
    throw new NotaError("invalid_argument", "purpose must be a non-empty string");
  }
  if (params.purpose.length > MAX_PURPOSE_LENGTH) {
    throw new NotaError("invalid_argument", `purpose must be at most ${MAX_PURPOSE_LENGTH} characters`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(agentId)) throw new NotaError("invalid_argument", "agentId must be 32 bytes of hex");
  if (!isValidCheckoutKind(kind)) throw new NotaError("invalid_argument", `invalid checkout kind: ${kind}`);
  const rawPurchaseRef = params.rawPurchaseRef ?? `nota_request_${randomBytes32().slice(2, 34)}`;
  assertRawPurchaseRef(rawPurchaseRef);

  const account = params.account ?? requireAccount(params.walletClient as WalletClient);
  const signer = account.address;

  const deployment = await assertDeployment(publicClient);
  const listing = await readListing(publicClient, deployment, listingId);
  if (!listing) throw new NotaError("listing_not_found", `Listing ${listingId} does not exist on chain ${deployment.chainId}`);
  if (!listing.active) throw new NotaError("listing_inactive", `Listing ${listingId} is inactive`);
  const seller = listing.seller;
  const signedBySeller = sameAddress(seller, signer);
  if (!signedBySeller && !(await isAuthorizedSigner(publicClient, deployment, listingId, signer))) {
    throw new NotaError(
      "not_authorized_signer",
      `${signer} is neither the seller of listing ${listingId} (${seller}) nor a quote signer the seller authorized for it`,
      { listingId, signer, seller },
    );
  }
  // claimedSigner: zero means "the seller"; anything else is checked against the listing's signers.
  const claimedSigner = signedBySeller ? zeroAddress : signer;

  // Chain time, not the local clock: the contract rejects issuedAt ahead of block.timestamp.
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const issuedAt = block.timestamp;
  const expiresAt = issuedAt + BigInt(expiresInSeconds);

  const purchaseRef = hashPurchaseRef({
    chainId: deployment.chainId,
    settlementToken: deployment.usdc,
    seller,
    rawPurchaseRef,
    // Nothing redeems these requests, so the nonce is used once here and discarded.
    nonce: randomBytes32(),
  });

  const partialQuote = { listingId, buyer: zeroAddress, purchaseRef, amount: params.amount, issuedAt, expiresAt };
  const metadata = buildCheckoutMetadata({
    deployment,
    seller,
    listingHash: listing.listingHash,
    quote: partialQuote,
    purpose: params.purpose,
    kind,
  });
  const quote: SignedReceiptQuote = {
    ...partialQuote,
    metadataHash: hashCheckoutMetadata(metadata),
    agentId,
    integratorFeeRecipient: zeroAddress,
    integratorFeeAmount: 0n,
  };

  const typedData = signedQuoteTypedData(quote, {
    chainId: deployment.chainId,
    store: deployment.store,
    settlementToken: deployment.usdc,
    purchaseRefRegistry: deployment.registry,
    seller,
  });
  let signature: Hex;
  if (params.account) {
    if (!params.account.signTypedData) throw new NotaError("invalid_argument", "account cannot sign typed data; pass a walletClient instead");
    signature = await params.account.signTypedData(typedData);
  } else {
    signature = await (params.walletClient as WalletClient).signTypedData({ ...typedData, account });
  }

  try {
    await validateOnChain(publicClient, deployment, quote, signature, zeroAddress, claimedSigner);
  } catch (error) {
    throw new NotaError("unexpected_revert", `The signed request did not validate on-chain: ${revertName(error) ?? (error as Error).message}`, undefined, {
      cause: error,
    });
  }

  const request: PaymentRequest = {
    chainId: deployment.chainId,
    store: deployment.store,
    seller,
    signer,
    quote,
    signature: signature.toLowerCase() as Hex,
    metadata,
    fromBlock: block.number,
  };
  return { ...request, fromBlock: block.number, url: encodeRequest(request, params.baseUrl ?? DEFAULT_BASE_URL), purchaseRef };
}

function validateOnChain(
  publicClient: PublicClient,
  deployment: NotaDeployment,
  quote: SignedReceiptQuote,
  signature: Hex,
  payer: Address,
  claimedSigner: Address,
) {
  return publicClient.readContract({
    address: deployment.store,
    abi: notaReceiptStoreAbi,
    functionName: "validateSignedReceiptPurchase",
    args: [quote, signature, payer, claimedSigner],
  });
}

function isAuthorizedSigner(publicClient: PublicClient, deployment: NotaDeployment, listingId: bigint, signer: Address) {
  return publicClient.readContract({
    address: deployment.store,
    abi: notaReceiptStoreAbi,
    functionName: "isQuoteSignerAuthorized",
    args: [listingId, signer],
  });
}

/** The `claimedSigner` argument for a request: zero when the seller signed it. */
export function claimedSignerOf(request: Pick<PaymentRequest, "seller" | "signer">): Address {
  return sameAddress(request.signer, request.seller) ? zeroAddress : request.signer;
}

export interface ReadRequestOptions {
  publicClient: PublicClient;
  /** The wallet that would pay. Used as `expectedBuyer` in the on-chain validation. */
  payer?: Address;
  /** Overrides the link's unsigned `fromBlock` hint for the receipt search. */
  fromBlock?: bigint;
  /** See `ReceiptSearchOptions`. */
  maxBlockRange?: bigint;
  /** See `ReceiptSearchOptions`. */
  maxRanges?: number;
}

const VALIDATION_ERROR_STATUS: Record<string, ReadRequestResult["status"]> = {
  QuoteExpired: "expired",
  InvalidQuoteSigner: "invalid_signature",
  ListingInactive: "listing_inactive",
  ListingNotFound: "listing_inactive",
  InvalidParams: "tampered",
  AmountOutOfBounds: "tampered",
  QuoteExpiryTooLong: "tampered",
  InvalidPurchaseRef: "tampered",
  IntegratorFeeTooHigh: "tampered",
  QuoteBuyerMismatch: "tampered",
};

/**
 * Decide what a payment link is. The link is untrusted input: it never chooses the contract,
 * and "paid" is reported only for a verified matching `ReceiptPurchasedV2` log.
 *
 * Throws `NotaError("invalid_link")` for undecodable input or an unknown version, and other
 * `NotaError`s for conditions that are not a property of the link (unsupported client chain,
 * deployment mismatch, purchases paused).
 */
export async function readRequest(input: RequestInput, options: ReadRequestOptions): Promise<ReadRequestResult> {
  const { publicClient } = options;
  const request = decodeRequest(input);
  const result = (status: ReadRequestResult["status"], reason?: string, extra?: Partial<ReadRequestResult>): ReadRequestResult => ({
    status,
    request,
    ...(reason !== undefined ? { reason } : {}),
    ...extra,
  });

  // 1. The link names a chain; the store must be the known store for it.
  const known = getDeployment(request.chainId);
  if (!known || !sameAddress(known.store, request.store)) {
    return result("unknown_store", `${request.store} is not the Nota store on chain ${request.chainId}`);
  }
  const clientChainId = await publicClient.getChainId();
  if (clientChainId !== request.chainId) {
    return result("wrong_chain", `request is for chain ${request.chainId}, client is on ${clientChainId}`);
  }
  const deployment = await assertDeployment(publicClient);

  // 2. The metadata must be the document the quote commits to, and agree with quote and chain.
  const problems = findMetadataProblems(request.metadata, request.quote, deployment);
  if (problems.length > 0) return result("tampered", problems.join("; "));

  // 3. Listing ownership: the seller named in the signed metadata must own the listing.
  const listing = await readListing(publicClient, deployment, request.quote.listingId);
  if (!listing) return result("listing_inactive", `listing ${request.quote.listingId} does not exist`);
  if (!sameAddress(listing.seller, request.seller)) {
    return result("invalid_signature", `listing ${request.quote.listingId} belongs to ${listing.seller}, not ${request.seller}`);
  }
  if (listing.listingHash.toLowerCase() !== request.metadata.listing.listingHash.toLowerCase()) {
    return result("tampered", "metadata listingHash does not match the on-chain listing");
  }

  // 4. Consumed is not paid: only a matching receipt is.
  const paidOrBlocked = async (): Promise<ReadRequestResult> => {
    const receipt = await findMatchingReceipt({
      publicClient,
      deployment,
      request,
      seller: listing.seller,
      fromBlock: options.fromBlock ?? request.fromBlock,
      ...(options.maxBlockRange !== undefined ? { maxBlockRange: options.maxBlockRange } : {}),
      ...(options.maxRanges !== undefined ? { maxRanges: options.maxRanges } : {}),
    });
    if (receipt) return result("paid", undefined, { receipt });
    return result(
      "blocked",
      "the payment reference was consumed but no matching receipt was found; this request can no longer be paid, issue a new one",
    );
  };
  if (await isPurchaseRefConsumed(publicClient, deployment, request)) return paidOrBlocked();

  // 5. Listing must be active.
  if (!listing.active) return result("listing_inactive", `listing ${request.quote.listingId} is inactive`);

  const block = await publicClient.getBlock({ blockTag: "latest" });
  if (request.quote.expiresAt <= block.timestamp) return result("expired", `expired at ${request.quote.expiresAt}`);

  // A quote signed by someone other than the seller needs that signer to be authorized for this
  // listing right now: revoking a signer kills its outstanding unpaid requests.
  const claimedSigner = claimedSignerOf(request);
  if (claimedSigner !== zeroAddress && !(await isAuthorizedSigner(publicClient, deployment, request.quote.listingId, claimedSigner))) {
    return result("invalid_signature", `${request.signer} is not an authorized quote signer for listing ${request.quote.listingId}`);
  }

  // 6. The contract's own validation path, without moving funds.
  try {
    const validation = await validateOnChain(publicClient, deployment, request.quote, request.signature, options.payer ?? zeroAddress, claimedSigner);
    if (!sameAddress(validation.verifiedSigner, request.signer) || validation.grossAmount !== request.quote.amount) {
      return result("invalid_signature", "on-chain validation returned an unexpected signer or amount");
    }
  } catch (error) {
    const name = revertName(error);
    if (name === "PurchaseRefAlreadyUsed") return paidOrBlocked();
    if (name === "PurchasesPaused") throw new NotaError("purchases_paused", "Purchases are paused on the Nota store", undefined, { cause: error });
    const status = name !== undefined ? VALIDATION_ERROR_STATUS[name] : undefined;
    if (status) return result(status, `validateSignedReceiptPurchase reverted with ${name}`);
    throw new NotaError("unexpected_revert", `validateSignedReceiptPurchase failed: ${name ?? (error as Error).message}`, undefined, {
      cause: error,
    });
  }

  return result("payable");
}
