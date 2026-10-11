import { encodeFunctionData, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { erc20Abi, notaReceiptStoreAbi } from "./abi.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { assertWalletChain, requireAccount, sameAddress } from "./chain.js";
import { matchesRequest, receiptFromLog, type RequestInput } from "./receipt.js";
import { readRequest } from "./request.js";
import type { NotaReceipt, PaymentRequest } from "./types.js";

export interface PayCall {
  to: Address;
  data: Hex;
}

export interface PreparePayCallsParams {
  publicClient: PublicClient;
  /** The link, or a decoded request. */
  request: RequestInput;
  /** The account that will send the calls: an EOA, or a smart account that batches them. */
  payer: Address;
}

export interface PreparedPayCalls {
  /**
   * In order: USDC `approve(store, amount)` for exactly the quoted amount, present only when the
   * payer's allowance is short, then `purchaseSignedReceipt(quote, signature, address(0))`.
   * Both send zero value. A smart account can batch them into one operation.
   */
  calls: PayCall[];
  needsApproval: boolean;
}

interface PreparedPayment extends PreparedPayCalls {
  request: PaymentRequest;
}

async function preparePayment(params: PreparePayCallsParams): Promise<PreparedPayment> {
  const { publicClient, payer } = params;

  const read = await readRequest(params.request, { publicClient, payer });
  if (read.status !== "payable") {
    throw new NotaError("not_payable", `Refusing to pay: request status is "${read.status}"${read.reason ? ` (${read.reason})` : ""}`, {
      status: read.status,
    });
  }
  const { request } = read;
  const { quote } = request;
  const deployment = await assertDeployment(publicClient);

  const [paused, balance, allowance] = await Promise.all([
    publicClient.readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName: "purchasesPaused" }),
    publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "allowance", args: [payer, deployment.store] }),
  ]);
  if (paused) throw new NotaError("purchases_paused", "Purchases are paused on the Nota store");
  if (balance < quote.amount) {
    throw new NotaError("insufficient_balance", `${payer} holds ${balance} USDC base units, needs ${quote.amount}`, {
      balance,
      amount: quote.amount,
    });
  }

  const needsApproval = allowance < quote.amount;
  const calls: PayCall[] = [];
  if (needsApproval) {
    calls.push({
      to: deployment.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.store, quote.amount] }),
    });
  }
  calls.push({
    to: deployment.store,
    data: encodeFunctionData({ abi: notaReceiptStoreAbi, functionName: "purchaseSignedReceipt", args: [quote, request.signature, zeroAddress] }),
  });
  return { calls, needsApproval, request };
}

/**
 * The calls that pay a request, without sending anything. Runs `readRequest` first and refuses
 * anything that is not "payable", and checks the payer's USDC balance. The approval, when
 * present, is for exactly the quoted amount, never unlimited.
 */
export async function preparePayCalls(params: PreparePayCallsParams): Promise<PreparedPayCalls> {
  const { calls, needsApproval } = await preparePayment(params);
  return { calls, needsApproval };
}

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
 * Pay a request from the wallet's account by sending the calls from `preparePayCalls` one at a
 * time. Funds go to the seller in the purchase transaction.
 */
export async function payRequest(params: PayRequestParams): Promise<PayRequestResult> {
  const { walletClient, publicClient } = params;
  const confirmations = params.confirmations ?? 1;
  const account = requireAccount(walletClient);
  const payer = account.address;

  const { calls, needsApproval, request } = await preparePayment({ publicClient, request: params.request, payer });
  const deployment = await assertDeployment(publicClient);
  await assertWalletChain(walletClient, deployment.chainId);
  const chain = walletClient.chain ?? null;

  const hashes: Hex[] = [];
  for (const call of calls) {
    // Simulate each call right before sending it, so a revert surfaces before it costs gas.
    await publicClient.call({ account, to: call.to, data: call.data });
    const hash = await walletClient.sendTransaction({ account, chain, to: call.to, data: call.data });
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
    if (txReceipt.status !== "success") {
      throw new NotaError("transaction_failed", `Transaction ${hash} to ${call.to} reverted`, { txHash: hash });
    }
    hashes.push(hash);
    if (call === calls[calls.length - 1]) {
      const logs = parseEventLogs({ abi: notaReceiptStoreAbi, eventName: "ReceiptPurchasedV2", logs: txReceipt.logs });
      for (const log of logs) {
        if (!sameAddress(log.address, deployment.store)) continue;
        const receipt = receiptFromLog(log, deployment.chainId);
        if (receipt && matchesRequest(receipt, request, request.metadata.seller) && sameAddress(receipt.payer, payer)) {
          return { ...(needsApproval ? { approveTxHash: hashes[0] } : {}), payTxHash: hash, receipt };
        }
      }
      throw new NotaError("receipt_mismatch", `Transaction ${hash} succeeded but emitted no matching ReceiptPurchasedV2`, { txHash: hash });
    }
  }
  throw new NotaError("transaction_failed", "No purchase call was prepared");
}
