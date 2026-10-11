import { encodeFunctionData, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { LISTING_MODE_SIGNED_QUOTE_ONLY, notaReceiptStoreAbi } from "./abi.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { canonicalize } from "./jcs.js";
import { hashListing } from "./metadata.js";
import { assertWalletChain, requireAccount, sameAddress } from "./chain.js";

export interface PreparedSetup {
  chainId: number;
  /** The store address. */
  to: Address;
  /** `createListing(listingHash, 0, SignedQuoteOnly)` calldata. */
  data: Hex;
  value: 0n;
  listingHash: Hex;
  /** The JCS-canonical listing document that `listingHash` commits to. */
  canonicalListing: string;
}

/** Build the one-time `createListing` transaction without sending it. */
export async function prepareSetup(params: { publicClient: PublicClient; listing: Record<string, unknown> }): Promise<PreparedSetup> {
  const deployment = await assertDeployment(params.publicClient);
  const listingHash = hashListing(params.listing);
  return {
    chainId: deployment.chainId,
    to: deployment.store,
    data: encodeFunctionData({
      abi: notaReceiptStoreAbi,
      functionName: "createListing",
      args: [listingHash, 0n, LISTING_MODE_SIGNED_QUOTE_ONLY],
    }),
    value: 0n,
    listingHash,
    canonicalListing: canonicalize(params.listing),
  };
}

export interface SetupParams {
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** Public listing document. Committed on-chain by hash only; keep it free of secrets and PII. */
  listing: Record<string, unknown>;
  confirmations?: number;
}

/**
 * Create the seller's `SignedQuoteOnly` listing. The wallet's account becomes the seller and the
 * recipient of every payment against it.
 */
export async function setup(params: SetupParams): Promise<{ listingId: bigint; txHash: Hex; listingHash: Hex }> {
  const { walletClient, publicClient } = params;
  const account = requireAccount(walletClient);
  const prepared = await prepareSetup({ publicClient, listing: params.listing });
  await assertWalletChain(walletClient, prepared.chainId);

  const args = [prepared.listingHash, 0n, LISTING_MODE_SIGNED_QUOTE_ONLY] as const;
  await publicClient.simulateContract({ account, address: prepared.to, abi: notaReceiptStoreAbi, functionName: "createListing", args });
  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain ?? null,
    address: prepared.to,
    abi: notaReceiptStoreAbi,
    functionName: "createListing",
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: params.confirmations ?? 1 });
  if (receipt.status !== "success") throw new NotaError("transaction_failed", `createListing transaction ${txHash} reverted`, { txHash });

  const created = parseEventLogs({ abi: notaReceiptStoreAbi, eventName: "ListingCreated", logs: receipt.logs }).find(
    (log) => sameAddress(log.address, prepared.to) && sameAddress(log.args.seller, account.address),
  );
  if (!created) throw new NotaError("receipt_mismatch", `createListing transaction ${txHash} emitted no ListingCreated for ${account.address}`, { txHash });
  return { listingId: created.args.listingId, txHash, listingHash: prepared.listingHash };
}
