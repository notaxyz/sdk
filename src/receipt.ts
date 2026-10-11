import { BlockNotFoundError, decodeEventLog, zeroAddress, type Log, type PublicClient } from "viem";

import { purchaseRefRegistryAbi, receiptPurchasedV2Event } from "./abi.js";
import type { NotaDeployment } from "./addresses.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { decodeRequest, type LinkPayload } from "./link.js";
import { hashCheckoutMetadata } from "./metadata.js";
import { readListing, sameAddress } from "./chain.js";
import type { NotaReceipt, PaymentRequest } from "./types.js";

export const DEFAULT_MAX_BLOCK_RANGE = 5_000n;
/** Most `eth_getLogs` ranges one receipt search may scan before giving up. */
export const DEFAULT_MAX_RANGES = 500;
/** How far before `issuedAt` the `fromBlock` hint's block may be. */
export const MAX_HINT_LEAD_SECONDS = 3600n;
export const DEFAULT_POLL_INTERVAL_MS = 4_000;

export type RequestInput = PaymentRequest | LinkPayload | string;

export interface ReceiptSearchOptions {
  /** Overrides the request's own `fromBlock` hint. */
  fromBlock?: bigint;
  /** Largest block span per `eth_getLogs` call. Public RPCs often cap this. Default 5000. */
  maxBlockRange?: bigint;
  /** Most `eth_getLogs` calls one search may make; the search reports no receipt when exhausted. Default 500. */
  maxRanges?: number;
}

/**
 * A `ReceiptPurchasedV2` log counts as this request's receipt only if it came from the known
 * store and its seller, purchaseRef, listingId, amount, metadataHash and agentId all equal the
 * request's. A consumed purchaseRef on its own proves nothing: anyone holding a link can consume
 * its ref against a listing of their own.
 */
export function matchesRequest(receipt: Omit<NotaReceipt, "txHash" | "blockNumber" | "logIndex">, request: PaymentRequest, seller: string): boolean {
  const { quote } = request;
  return (
    sameAddress(receipt.store, request.store) &&
    sameAddress(receipt.seller, seller) &&
    receipt.purchaseRef.toLowerCase() === quote.purchaseRef.toLowerCase() &&
    receipt.listingId === quote.listingId &&
    receipt.amount === quote.amount &&
    receipt.metadataHash.toLowerCase() === quote.metadataHash.toLowerCase() &&
    receipt.agentId.toLowerCase() === quote.agentId.toLowerCase()
  );
}

export function receiptFromLog(log: Log, chainId: number): NotaReceipt | undefined {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: [receiptPurchasedV2Event], data: log.data, topics: log.topics, strict: true });
  } catch {
    return undefined;
  }
  if (decoded.eventName !== "ReceiptPurchasedV2" || log.transactionHash === null || log.blockNumber === null || log.logIndex === null) {
    return undefined;
  }
  const args = decoded.args;
  return {
    chainId,
    store: log.address,
    receiptId: args.receiptId,
    seller: args.seller,
    payer: args.buyer,
    listingId: args.listingId,
    purchaseRef: args.purchaseRef,
    amount: args.amount,
    metadataHash: args.metadataHash,
    agentId: args.agentId,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}

/**
 * Scan for the request's matching receipt from `fromBlock`, in bounded ranges, filtered on the
 * indexed purchaseRef and seller topics. Returns null when nothing matches.
 *
 * The search is bounded so an untrusted hint cannot cause a long scan:
 *   - The block at `fromBlock` must exist and its timestamp must lie between
 *     `issuedAt - 3600` and `expiresAt`; otherwise the hint is invalid and the result is null
 *     (which callers report as "blocked", never "paid").
 *   - It stops at the latest block, once a range ends after the quote's expiry (a valid purchase
 *     cannot land later), or after `maxRanges` ranges.
 */
export async function findMatchingReceipt(
  params: {
    publicClient: PublicClient;
    deployment: NotaDeployment;
    request: PaymentRequest;
    seller: `0x${string}`;
    fromBlock: bigint | undefined;
  } & Omit<ReceiptSearchOptions, "fromBlock">,
): Promise<NotaReceipt | null> {
  const { publicClient, deployment, request, seller } = params;
  if (params.fromBlock === undefined || params.fromBlock < 0n) return null;
  const maxRange = params.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE;
  if (maxRange < 1n) throw new NotaError("invalid_argument", "maxBlockRange must be at least 1");
  const maxRanges = params.maxRanges ?? DEFAULT_MAX_RANGES;
  if (!Number.isInteger(maxRanges) || maxRanges < 1) throw new NotaError("invalid_argument", "maxRanges must be a positive integer");

  // Validate the hint before scanning anything.
  let start;
  try {
    start = await publicClient.getBlock({ blockNumber: params.fromBlock });
  } catch (error) {
    if (error instanceof BlockNotFoundError) return null;
    throw error;
  }
  if (!start || start.timestamp + MAX_HINT_LEAD_SECONDS < request.quote.issuedAt || start.timestamp > request.quote.expiresAt) return null;

  // cacheTime 0: a cached (stale) head would end the search before a just-mined receipt.
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
  let from = params.fromBlock;
  for (let ranges = 0; from <= latest && ranges < maxRanges; ranges++) {
    const to = from + maxRange - 1n < latest ? from + maxRange - 1n : latest;
    const logs = await publicClient.getLogs({
      address: deployment.store,
      event: receiptPurchasedV2Event,
      args: { purchaseRef: request.quote.purchaseRef, seller },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    for (const log of logs) {
      const receipt = receiptFromLog(log as Log, deployment.chainId);
      if (receipt && receipt.blockNumber >= params.fromBlock && matchesRequest(receipt, request, seller)) return receipt;
    }
    if (to >= latest) break;
    const block = await publicClient.getBlock({ blockNumber: to });
    if (block.timestamp > request.quote.expiresAt) break;
    from = to + 1n;
  }
  return null;
}

interface ResolvedRequest {
  deployment: NotaDeployment;
  request: PaymentRequest;
}

async function resolveRequest(publicClient: PublicClient, input: RequestInput): Promise<ResolvedRequest> {
  const request = decodeRequest(input);
  const deployment = await assertDeployment(publicClient);
  if (request.chainId !== deployment.chainId || !sameAddress(request.store, deployment.store)) {
    throw new NotaError("invalid_argument", "request is not for this chain's Nota store", {
      chainId: request.chainId,
      store: request.store,
    });
  }
  if (hashCheckoutMetadata(request.metadata).toLowerCase() !== request.quote.metadataHash.toLowerCase()) {
    throw new NotaError("invalid_argument", "request metadata does not match quote.metadataHash");
  }
  if (request.seller === zeroAddress) {
    throw new NotaError("invalid_argument", "request metadata names no valid seller, so no receipt can match it");
  }
  return { deployment, request };
}

/** @internal */
export async function isPurchaseRefConsumed(publicClient: PublicClient, deployment: NotaDeployment, request: PaymentRequest): Promise<boolean> {
  return publicClient.readContract({
    address: deployment.registry,
    abi: purchaseRefRegistryAbi,
    functionName: "isConsumed",
    args: [request.quote.purchaseRef],
  });
}

/** The listing's on-chain seller, which must be the seller the request names. */
async function onChainSeller(publicClient: PublicClient, deployment: NotaDeployment, request: PaymentRequest): Promise<`0x${string}` | undefined> {
  const listing = await readListing(publicClient, deployment, request.quote.listingId);
  if (!listing || !sameAddress(listing.seller, request.seller)) return undefined;
  return listing.seller;
}

function blocked(request: PaymentRequest, reason: string): NotaError {
  return new NotaError(
    "purchase_ref_blocked",
    `Payment reference ${request.quote.purchaseRef} was consumed without a matching payment (${reason}). ` +
      "Treat this request as unpaid and issue a new one.",
    { purchaseRef: request.quote.purchaseRef, reason },
  );
}

export interface GetReceiptParams extends ReceiptSearchOptions {
  publicClient: PublicClient;
  /** A `createRequest` result, a decoded request, or the link itself. */
  request: RequestInput;
}

/**
 * The verified receipt for a request, or `null` if it has not been paid yet.
 *
 * Throws `NotaError` with code `"purchase_ref_blocked"` when the purchaseRef has been consumed
 * but no matching receipt exists from `fromBlock` onwards. That request can never be paid.
 */
export async function getReceipt(params: GetReceiptParams): Promise<NotaReceipt | null> {
  const { publicClient } = params;
  const { deployment, request } = await resolveRequest(publicClient, params.request);
  if (!(await isPurchaseRefConsumed(publicClient, deployment, request))) return null;
  return requireMatchingReceipt(publicClient, deployment, request, params);
}

async function requireMatchingReceipt(
  publicClient: PublicClient,
  deployment: NotaDeployment,
  request: PaymentRequest,
  options: ReceiptSearchOptions,
): Promise<NotaReceipt> {
  const seller = await onChainSeller(publicClient, deployment, request);
  if (!seller) throw blocked(request, "the listing's on-chain seller is not the request's seller");
  const fromBlock = options.fromBlock ?? request.fromBlock;
  if (fromBlock === undefined) throw blocked(request, "no fromBlock to search for the receipt from");
  const receipt = await findMatchingReceipt({
    publicClient,
    deployment,
    request,
    seller,
    fromBlock,
    ...(options.maxBlockRange !== undefined ? { maxBlockRange: options.maxBlockRange } : {}),
    ...(options.maxRanges !== undefined ? { maxRanges: options.maxRanges } : {}),
  });
  if (!receipt) throw blocked(request, `no matching ReceiptPurchasedV2 log found from block ${fromBlock} (or that block is not a valid starting point)`);
  return receipt;
}

export interface WaitForReceiptParams extends GetReceiptParams {
  /** Give up after this long. Default: until the quote expires, plus one minute. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * After the ref is consumed, how many extra log searches to make before concluding it was
   * blocked. Covers RPC nodes whose log index lags their state. Default 3.
   */
  blockedRetries?: number;
  signal?: AbortSignal;
}

/**
 * Resolve once a matching receipt exists. Rejects with `"purchase_ref_blocked"` if the ref is
 * consumed without one (so a caller never concludes it was funded), or `"timeout"`.
 */
export async function waitForReceipt(params: WaitForReceiptParams): Promise<NotaReceipt> {
  const { publicClient } = params;
  const { deployment, request } = await resolveRequest(publicClient, params.request);
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = params.timeoutMs ?? Math.max(0, Number(request.quote.expiresAt) * 1000 - Date.now()) + 60_000;
  const deadline = Date.now() + timeoutMs;
  const retries = params.blockedRetries ?? 3;

  for (;;) {
    params.signal?.throwIfAborted();
    if (await isPurchaseRefConsumed(publicClient, deployment, request)) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await requireMatchingReceipt(publicClient, deployment, request, params);
        } catch (error) {
          if (!(error instanceof NotaError) || error.code !== "purchase_ref_blocked" || attempt >= retries) throw error;
        }
        await sleep(pollIntervalMs, params.signal);
      }
    }
    if (Date.now() >= deadline) {
      throw new NotaError("timeout", `No payment for ${request.quote.purchaseRef} within ${timeoutMs} ms`, {
        purchaseRef: request.quote.purchaseRef,
      });
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), params.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

