import { isAddress, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { notaReceiptStoreAbi } from "./abi.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { assertWalletChain, readListing, requireAccount, revertName, sameAddress } from "./chain.js";

export interface SignerParams {
  /** Must be the listing's seller. */
  walletClient: WalletClient;
  publicClient: PublicClient;
  listingId: bigint | number | string;
  /** The quote signer to authorize or revoke, e.g. a server-side hot key. */
  signer: Address;
  confirmations?: number;
}

/**
 * Let `signer` issue payment requests for one of the seller's listings. Payments still go to the
 * seller. The contract allows at most 3 authorized signers per listing; the seller is always a
 * valid signer and cannot be added.
 */
export function authorizeSigner(params: SignerParams): Promise<{ txHash: Hex }> {
  return setQuoteSigner(params, true);
}

/** Revoke a signer. Its unpaid requests stop being payable immediately. */
export function revokeSigner(params: SignerParams): Promise<{ txHash: Hex }> {
  return setQuoteSigner(params, false);
}

async function setQuoteSigner(params: SignerParams, authorized: boolean): Promise<{ txHash: Hex }> {
  const { walletClient, publicClient } = params;
  const account = requireAccount(walletClient);
  let listingId: bigint;
  try {
    listingId = BigInt(params.listingId);
  } catch {
    throw new NotaError("invalid_argument", `listingId must be an integer, got ${String(params.listingId)}`);
  }
  if (!isAddress(params.signer, { strict: false }) || params.signer.toLowerCase() === zeroAddress) {
    throw new NotaError("invalid_argument", "signer must be a non-zero address");
  }
  if (sameAddress(params.signer, account.address)) {
    throw new NotaError("invalid_argument", "the seller is always a valid signer and cannot be authorized or revoked");
  }

  const deployment = await assertDeployment(publicClient);
  await assertWalletChain(walletClient, deployment.chainId);
  const listing = await readListing(publicClient, deployment, listingId);
  if (!listing) throw new NotaError("listing_not_found", `Listing ${listingId} does not exist on chain ${deployment.chainId}`);
  if (!sameAddress(listing.seller, account.address)) {
    throw new NotaError("not_listing_seller", `Listing ${listingId} belongs to ${listing.seller}; only the seller can change its signers`);
  }

  const args = [listingId, params.signer, authorized] as const;
  try {
    await publicClient.simulateContract({ account, address: deployment.store, abi: notaReceiptStoreAbi, functionName: "setListingQuoteSigner", args });
  } catch (error) {
    const name = revertName(error);
    if (name === "QuoteSignerLimitReached") {
      throw new NotaError("invalid_argument", `Listing ${listingId} already has the maximum of 3 authorized signers; revoke one first`, undefined, { cause: error });
    }
    throw new NotaError("unexpected_revert", `setListingQuoteSigner would revert: ${name ?? (error as Error).message}`, undefined, { cause: error });
  }
  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain ?? null,
    address: deployment.store,
    abi: notaReceiptStoreAbi,
    functionName: "setListingQuoteSigner",
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: params.confirmations ?? 1 });
  if (receipt.status !== "success") throw new NotaError("transaction_failed", `setListingQuoteSigner transaction ${txHash} reverted`, { txHash });
  return { txHash };
}
