import type { PublicClient } from "viem";

import { notaReceiptStoreAbi } from "./abi.js";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  SIGNED_RECEIPT_QUOTE_TYPEHASH,
  getDeployment,
  type NotaDeployment,
} from "./addresses.js";
import { NotaError } from "./errors.js";

const verified = new WeakMap<object, Promise<NotaDeployment>>();

/**
 * Resolve the deployment for the client's chain and confirm on-chain that the store's
 * immutables (SETTLEMENT_TOKEN, PURCHASE_REF_REGISTRY), EIP-712 domain and quote typehash match
 * the address table and this SDK. The result is cached per client; a failure is not cached.
 */
export function assertDeployment(publicClient: PublicClient): Promise<NotaDeployment> {
  const cached = verified.get(publicClient);
  if (cached) return cached;
  const pending = verifyDeployment(publicClient);
  verified.set(publicClient, pending);
  pending.catch(() => verified.delete(publicClient));
  return pending;
}

async function verifyDeployment(publicClient: PublicClient): Promise<NotaDeployment> {
  const chainId = await publicClient.getChainId();
  const deployment = getDeployment(chainId);
  if (!deployment) {
    throw new NotaError("unsupported_chain", `Chain ${chainId} is not supported by @notaxyz/sdk`, { chainId });
  }

  let token: string, registry: string, name: string, version: string, typehash: string;
  try {
    const read = <F extends "SETTLEMENT_TOKEN" | "PURCHASE_REF_REGISTRY" | "EIP712_NAME" | "EIP712_VERSION" | "SIGNED_RECEIPT_QUOTE_TYPEHASH">(
      functionName: F,
    ) => publicClient.readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName });
    [token, registry, name, version, typehash] = await Promise.all([
      read("SETTLEMENT_TOKEN"),
      read("PURCHASE_REF_REGISTRY"),
      read("EIP712_NAME"),
      read("EIP712_VERSION"),
      read("SIGNED_RECEIPT_QUOTE_TYPEHASH"),
    ]);
  } catch (error) {
    throw new NotaError(
      "deployment_mismatch",
      `Could not read NotaReceiptStore at ${deployment.store} on chain ${chainId}`,
      { chainId },
      { cause: error },
    );
  }

  const mismatches: string[] = [];
  if (token.toLowerCase() !== deployment.usdc.toLowerCase()) mismatches.push(`SETTLEMENT_TOKEN is ${token}, expected ${deployment.usdc}`);
  if (registry.toLowerCase() !== deployment.registry.toLowerCase()) {
    mismatches.push(`PURCHASE_REF_REGISTRY is ${registry}, expected ${deployment.registry}`);
  }
  if (name !== EIP712_DOMAIN_NAME) mismatches.push(`EIP712_NAME is ${name}, expected ${EIP712_DOMAIN_NAME}`);
  if (version !== EIP712_DOMAIN_VERSION) mismatches.push(`EIP712_VERSION is ${version}, expected ${EIP712_DOMAIN_VERSION}`);
  if (typehash.toLowerCase() !== SIGNED_RECEIPT_QUOTE_TYPEHASH) {
    mismatches.push(`SIGNED_RECEIPT_QUOTE_TYPEHASH is ${typehash}, expected ${SIGNED_RECEIPT_QUOTE_TYPEHASH}`);
  }
  if (mismatches.length > 0) {
    throw new NotaError("deployment_mismatch", `NotaReceiptStore on chain ${chainId} does not match: ${mismatches.join("; ")}`, {
      chainId,
      mismatches,
    });
  }
  return deployment;
}
