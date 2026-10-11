import type { Address } from "viem";

export interface NotaDeployment {
  chainId: number;
  name: string;
  /** NotaReceiptStore. Also the EIP-712 `verifyingContract`. */
  store: Address;
  /** PurchaseRefRegistry the store consumes purchase references in. */
  registry: Address;
  /** Native USDC, the store's immutable SETTLEMENT_TOKEN. */
  usdc: Address;
  /** Block explorer base URL, without a trailing slash. */
  explorer: string;
}

export const NOTA_RECEIPT_STORE: Address = "0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88";
export const PURCHASE_REF_REGISTRY: Address = "0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991";

/**
 * Supported deployments. Store and registry addresses are identical on both chains because the
 * same deployer used the same nonces; the deployed bytecode is not identical (Arbitrum One also
 * has `attestReceipt`), but everything this SDK calls is the same on both.
 */
export const NOTA_DEPLOYMENTS = {
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    store: NOTA_RECEIPT_STORE,
    registry: PURCHASE_REF_REGISTRY,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorer: "https://arbiscan.io",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    store: NOTA_RECEIPT_STORE,
    registry: PURCHASE_REF_REGISTRY,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
  },
} as const satisfies Record<number, NotaDeployment>;

export type SupportedChainId = keyof typeof NOTA_DEPLOYMENTS;

export const SUPPORTED_CHAIN_IDS = Object.keys(NOTA_DEPLOYMENTS).map(Number) as SupportedChainId[];

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return Object.prototype.hasOwnProperty.call(NOTA_DEPLOYMENTS, chainId);
}

/** The deployment for `chainId`, or `undefined` when the chain is not supported. */
export function getDeployment(chainId: number): NotaDeployment | undefined {
  return isSupportedChainId(chainId) ? NOTA_DEPLOYMENTS[chainId] : undefined;
}

/** EIP-712 signing domain constants of NotaReceiptStore. */
export const EIP712_DOMAIN_NAME = "NotaReceiptStore";
export const EIP712_DOMAIN_VERSION = "2";

/** USDC uses 6 decimals on both supported chains. */
export const USDC_DECIMALS = 6;
