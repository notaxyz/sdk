import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { notaReceiptStoreAbi } from "./abi.js";
import type { NotaDeployment } from "./addresses.js";
import { NotaError } from "./errors.js";

/** The custom error name of a contract revert, or undefined when the error is not a decoded revert. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName;
  return undefined;
}

export interface OnChainListing {
  seller: Address;
  listingHash: Hex;
  unitPrice: bigint;
  active: boolean;
  mode: number;
}

/** `getListing`, with `ListingNotFound` turned into `undefined`. */
export async function readListing(
  publicClient: PublicClient,
  deployment: NotaDeployment,
  listingId: bigint,
): Promise<OnChainListing | undefined> {
  try {
    return await publicClient.readContract({
      address: deployment.store,
      abi: notaReceiptStoreAbi,
      functionName: "getListing",
      args: [listingId],
    });
  } catch (error) {
    if (revertName(error) === "ListingNotFound") return undefined;
    throw error;
  }
}

export function requireAccount(walletClient: WalletClient): Account {
  const account = walletClient.account;
  if (!account) throw new NotaError("invalid_argument", "walletClient has no account; create it with an `account`");
  return account;
}

/** The wallet must be on the chain the public client reads, or writes would land elsewhere. */
export async function assertWalletChain(walletClient: WalletClient, chainId: number): Promise<void> {
  const walletChainId = await walletClient.getChainId();
  if (walletChainId !== chainId) {
    throw new NotaError("unsupported_chain", `walletClient is on chain ${walletChainId}, expected ${chainId}`, {
      walletChainId,
      chainId,
    });
  }
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
