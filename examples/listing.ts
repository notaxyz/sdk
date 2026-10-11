/**
 * Listing resolution for examples/agent.ts, kept separate so it can be tested offline.
 */
import type { Address, PublicClient } from "viem";

import { notaReceiptStoreAbi, type NotaDeployment } from "../src/index.js";
import { readListing, sameAddress } from "../src/chain.js";

export type ListingSource = "--listing-id flag" | "LISTING_ID env" | "saved file";

export interface ResolvedListing {
  listingId: bigint;
  source: ListingSource;
  /** True for the flag and env sources: the user named this listing on purpose. */
  explicit: boolean;
}

/** A user-facing refusal; the example prints the message and exits non-zero. */
export class ListingError extends Error {
  override name = "ListingError";
}

function parseListingId(value: string, source: ListingSource): bigint {
  if (!/^[1-9][0-9]*$/.test(value.trim())) throw new ListingError(`Invalid listing id "${value}" from ${source}: expected a positive integer.`);
  return BigInt(value.trim());
}

/**
 * Pick the listing id: --listing-id, then LISTING_ID, then the saved file. Returns undefined
 * when none is set (the caller then offers the one-time setup). Refuses --setup together with an
 * explicit id, so an existing listing is never duplicated by accident.
 */
export function resolveListingId(input: {
  flag?: string | undefined;
  env?: string | undefined;
  saved?: bigint | undefined;
  setup?: boolean | undefined;
}): ResolvedListing | undefined {
  let resolved: ResolvedListing | undefined;
  if (input.flag !== undefined && input.flag !== "") {
    resolved = { listingId: parseListingId(input.flag, "--listing-id flag"), source: "--listing-id flag", explicit: true };
  } else if (input.env !== undefined && input.env !== "") {
    resolved = { listingId: parseListingId(input.env, "LISTING_ID env"), source: "LISTING_ID env", explicit: true };
  } else if (input.saved !== undefined) {
    resolved = { listingId: input.saved, source: "saved file", explicit: false };
  }
  if (input.setup && resolved?.explicit) {
    throw new ListingError(
      `Refusing --setup: listing ${resolved.listingId} was given via ${resolved.source}, and setup would create a second listing. ` +
        "Drop --setup to use that listing, or drop the listing id to create a new one.",
    );
  }
  return resolved;
}

export interface VerifiedListing {
  /** Who gets paid. */
  seller: Address;
  /** Whether the wallet is the seller itself or a quote signer the seller authorized. */
  role: "seller" | "signer";
}

/**
 * The listing must exist and be active, and the wallet must be able to sign quotes for it.
 * `isQuoteSignerAuthorized` is true for the seller and for authorized signers.
 */
export async function verifyListing(params: {
  publicClient: PublicClient;
  deployment: NotaDeployment;
  listingId: bigint;
  wallet: Address;
}): Promise<VerifiedListing> {
  const { publicClient, deployment, listingId, wallet } = params;
  const listing = await readListing(publicClient, deployment, listingId);
  if (!listing) throw new ListingError(`Listing ${listingId} does not exist on ${deployment.name}.`);
  if (!listing.active) throw new ListingError(`Listing ${listingId} on ${deployment.name} is inactive; its seller deactivated it.`);
  const canSign = await publicClient.readContract({
    address: deployment.store,
    abi: notaReceiptStoreAbi,
    functionName: "isQuoteSignerAuthorized",
    args: [listingId, wallet],
  });
  if (!canSign) {
    throw new ListingError(
      `Wallet ${wallet} is neither the seller of listing ${listingId} (${listing.seller}) nor an authorized quote signer for it. ` +
        "Ask the seller to run authorizeSigner for this wallet, or use a listing this wallet owns.",
    );
  }
  return { seller: listing.seller, role: sameAddress(listing.seller, wallet) ? "seller" : "signer" };
}

/** The one line the example prints about the listing in use. */
export function describeListing(resolved: ResolvedListing, verified: VerifiedListing): string {
  const base = `Using listing ${resolved.listingId} (from ${resolved.source})`;
  return verified.role === "seller"
    ? `${base}; this wallet is its seller.`
    : `${base}; this wallet is an authorized signer, payments go to the seller ${verified.seller}.`;
}
