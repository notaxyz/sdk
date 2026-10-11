import { BaseError, ExecutionRevertedError, encodeFunctionData, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { erc20Abi, notaReceiptStoreAbi } from "./abi.js";
import { assertDeployment } from "./deployment.js";
import { NotaError } from "./errors.js";
import { assertWalletChain, requireAccount, sameAddress } from "./chain.js";
import { matchesRequest, receiptFromLog, type RequestInput } from "./receipt.js";
import { claimedSignerOf, readRequest } from "./request.js";
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
   * payer's allowance is short, then `purchaseSignedReceipt(quote, signature, claimedSigner)`,
   * where claimedSigner is the zero address when the seller signed and the signer otherwise.
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
    data: encodeFunctionData({
      abi: notaReceiptStoreAbi,
      functionName: "purchaseSignedReceipt",
      args: [quote, request.signature, claimedSignerOf(request)],
    }),
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

/** Retries of the purchase simulation right after a fresh approval, 1 second apart. */
export const PURCHASE_SIMULATION_RETRIES = 5;
const PURCHASE_SIMULATION_RETRY_DELAY_MS = 1_000;

function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((cause) => cause instanceof ExecutionRevertedError || (cause as { code?: unknown }).code === 3) !== null;
}

export type PayStepName = "approve" | "pay";
export type PayStepState = "skipped" | "awaiting_signature" | "submitted" | "confirmed";

export interface PayStep {
  step: PayStepName;
  state: PayStepState;
  /** Present for "submitted" and "confirmed". */
  txHash?: Hex;
}

export interface PayRequestParams {
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** The link, or a decoded request. */
  request: RequestInput;
  /** Confirmations to wait for on each transaction. Default 1. */
  confirmations?: number;
  /**
   * Progress callback, e.g. to tell the user which wallet prompt is coming. Called in order:
   * approve (either "skipped", or "awaiting_signature" -> "submitted" -> "confirmed"), then pay
   * ("awaiting_signature" -> "submitted" -> "confirmed"). Nothing is reported for a request
   * that is refused before any transaction. The callback is not awaited, and an error it throws
   * is ignored so it cannot interrupt a payment halfway.
   */
  onStep?: (step: PayStep) => void;
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
  const report = (step: PayStep) => {
    try {
      params.onStep?.(step);
    } catch {
      // A UI callback must not abort a payment between its approve and purchase transactions.
    }
  };

  const { calls, needsApproval, request } = await preparePayment({ publicClient, request: params.request, payer });
  const deployment = await assertDeployment(publicClient);
  await assertWalletChain(walletClient, deployment.chainId);
  const chain = walletClient.chain ?? null;

  const simulate = (call: PayCall) => publicClient.call({ account, to: call.to, data: call.data });

  const send = async (step: PayStepName, call: PayCall, simulateFirst: (call: PayCall) => Promise<unknown> = simulate) => {
    // Simulate right before sending, so a revert surfaces before it costs gas.
    await simulateFirst(call);
    report({ step, state: "awaiting_signature" });
    const txHash = await walletClient.sendTransaction({ account, chain, to: call.to, data: call.data });
    report({ step, state: "submitted", txHash });
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations });
    if (txReceipt.status !== "success") {
      throw new NotaError("transaction_failed", `${step} transaction ${txHash} to ${call.to} reverted`, { txHash, step });
    }
    report({ step, state: "confirmed", txHash });
    return { txHash, txReceipt };
  };

  const purchaseCall = calls[calls.length - 1];
  if (!purchaseCall) throw new NotaError("transaction_failed", "No purchase call was prepared");

  let approveTxHash: Hex | undefined;
  if (needsApproval) {
    approveTxHash = (await send("approve", calls[0]!)).txHash;
  } else {
    report({ step: "approve", state: "skipped" });
  }

  // Right after an approval, the RPC node answering the simulation may not see the new allowance
  // yet (load-balanced or lagging nodes), so a revert there is retried before giving up.
  const simulateAfterApproval = async (call: PayCall, approvedIn: Hex) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await simulate(call);
      } catch (error) {
        if (!isRevert(error)) throw error;
        if (attempt >= PURCHASE_SIMULATION_RETRIES) {
          throw new NotaError(
            "purchase_simulation_failed",
            `The USDC approval succeeded (${approvedIn}), but the purchase still fails to simulate after ` +
              `${PURCHASE_SIMULATION_RETRIES} retries: ${(error as Error).message.split("\n")[0]}. ` +
              "Nothing was charged. Paying again will skip the approval.",
            { approveTxHash: approvedIn },
            { cause: error },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, PURCHASE_SIMULATION_RETRY_DELAY_MS));
      }
    }
  };

  const approvedIn = approveTxHash;
  const simulatePurchase = approvedIn === undefined ? simulate : (call: PayCall) => simulateAfterApproval(call, approvedIn);
  const { txHash: payTxHash, txReceipt } = await send("pay", purchaseCall, simulatePurchase);
  const logs = parseEventLogs({ abi: notaReceiptStoreAbi, eventName: "ReceiptPurchasedV2", logs: txReceipt.logs });
  for (const log of logs) {
    if (!sameAddress(log.address, deployment.store)) continue;
    const receipt = receiptFromLog(log, deployment.chainId);
    if (receipt && matchesRequest(receipt, request, request.seller) && sameAddress(receipt.payer, payer)) {
      return { ...(approveTxHash ? { approveTxHash } : {}), payTxHash, receipt };
    }
  }
  throw new NotaError("receipt_mismatch", `Transaction ${payTxHash} succeeded but emitted no matching ReceiptPurchasedV2`, { txHash: payTxHash });
}
