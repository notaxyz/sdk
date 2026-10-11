import { parseEventLogs, zeroAddress, type Hex, type PublicClient, type WalletClient } from "viem";

import { erc20Abi, notaReceiptStoreAbi } from "./abi.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { assertWalletChain, requireAccount, sameAddress } from "./chain.js";
import { matchesRequest, receiptFromLog, type RequestInput } from "./receipt.js";
import { readRequest } from "./request.js";
import type { NotaReceipt } from "./types.js";

export interface PayRequestParams {
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** The link, or a decoded request. */
  request: RequestInput;
  /** Confirmations to wait for on each transaction. Default 1. */
  confirmations?: number;
}

export interface PayRequestResult {
  /** Present only when an approval was needed. */
  approveTxHash?: Hex;
  payTxHash: Hex;
  receipt: NotaReceipt;
}

/**
 * Pay a request from the wallet's account. Refuses anything `readRequest` does not call
 * "payable". Approves exactly the quoted amount (never unlimited) and skips the approval when
 * the existing allowance already covers it. Funds go to the seller in the purchase transaction.
 */
export async function payRequest(params: PayRequestParams): Promise<PayRequestResult> {
  const { walletClient, publicClient } = params;
  const confirmations = params.confirmations ?? 1;
  const account = requireAccount(walletClient);
  const payer = account.address;

  const read = await readRequest(params.request, { publicClient, payer });
  if (read.status !== "payable") {
    throw new NotaError("not_payable", `Refusing to pay: request status is "${read.status}"${read.reason ? ` (${read.reason})` : ""}`, {
      status: read.status,
    });
  }
  const { request } = read;
  const { quote } = request;
  const deployment = await assertDeployment(publicClient);
  await assertWalletChain(walletClient, deployment.chainId);

  const paused = await publicClient.readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName: "purchasesPaused" });
  if (paused) throw new NotaError("purchases_paused", "Purchases are paused on the Nota store");

  const balance = await publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] });
  if (balance < quote.amount) {
    throw new NotaError("insufficient_balance", `${payer} holds ${balance} USDC base units, needs ${quote.amount}`, {
      balance,
      amount: quote.amount,
    });
  }

  const chain = walletClient.chain ?? null;
  let approveTxHash: Hex | undefined;
  const allowance = await publicClient.readContract({
    address: deployment.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [payer, deployment.store],
  });
  if (allowance < quote.amount) {
    await publicClient.simulateContract({
      account,
      address: deployment.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [deployment.store, quote.amount],
    });
    approveTxHash = await walletClient.writeContract({
      account,
      chain,
      address: deployment.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [deployment.store, quote.amount],
    });
    const approval = await publicClient.waitForTransactionReceipt({ hash: approveTxHash, confirmations });
    if (approval.status !== "success") {
      throw new NotaError("transaction_failed", `USDC approve transaction ${approveTxHash} reverted`, { txHash: approveTxHash });
    }
  }

  const args = [quote, request.signature, zeroAddress] as const;
  await publicClient.simulateContract({ account, address: deployment.store, abi: notaReceiptStoreAbi, functionName: "purchaseSignedReceipt", args });
  const payTxHash = await walletClient.writeContract({
    account,
    chain,
    address: deployment.store,
    abi: notaReceiptStoreAbi,
    functionName: "purchaseSignedReceipt",
    args,
  });
  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: payTxHash, confirmations });
  if (txReceipt.status !== "success") {
    throw new NotaError("transaction_failed", `purchaseSignedReceipt transaction ${payTxHash} reverted`, { txHash: payTxHash });
  }

  const logs = parseEventLogs({ abi: notaReceiptStoreAbi, eventName: "ReceiptPurchasedV2", logs: txReceipt.logs });
  for (const log of logs) {
    if (!sameAddress(log.address, deployment.store)) continue;
    const receipt = receiptFromLog(log, deployment.chainId);
    if (receipt && matchesRequest(receipt, request, request.metadata.seller) && sameAddress(receipt.payer, payer)) {
      return { ...(approveTxHash ? { approveTxHash } : {}), payTxHash, receipt };
    }
  }
  throw new NotaError("receipt_mismatch", `Transaction ${payTxHash} succeeded but emitted no matching ReceiptPurchasedV2`, { txHash: payTxHash });
}
