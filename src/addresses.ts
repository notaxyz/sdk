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
  /** True for test networks, whose USDC has no value. */
  testnet: boolean;
  /** Payment page that links for this chain point at by default, without a fragment. */
  payBaseUrl: string;
}

/** Payment page for mainnet links. */
export const MAINNET_PAY_BASE_URL = "https://usenota.xyz/pay";
/** Payment page for testnet links. */
export const TESTNET_PAY_BASE_URL = "https://dev.usenota.xyz/pay";

/** NotaReceiptStore on the mainnets (Arbitrum One and Base). */
export const NOTA_RECEIPT_STORE: Address = "0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88";
/** PurchaseRefRegistry on the mainnets (Arbitrum One and Base). */
export const PURCHASE_REF_REGISTRY: Address = "0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991";

/**
 * Supported deployments. Store and registry addresses are identical on the two mainnets because
 * the same deployer used the same nonces; the deployed bytecode is not identical (Arbitrum One
 * also has `attestReceipt`), but everything this SDK calls is the same on both. Arbitrum Sepolia
 * is a testnet deployment of the Arbitrum One source, at different addresses.
 */
export const NOTA_DEPLOYMENTS = {
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    store: NOTA_RECEIPT_STORE,
    registry: PURCHASE_REF_REGISTRY,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorer: "https://arbiscan.io",
    testnet: false,
    payBaseUrl: MAINNET_PAY_BASE_URL,
  },
  8453: {
    chainId: 8453,
    name: "Base",
    store: NOTA_RECEIPT_STORE,
    registry: PURCHASE_REF_REGISTRY,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
    testnet: false,
    payBaseUrl: MAINNET_PAY_BASE_URL,
  },
  421614: {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    store: "0x6b13e2077c84e1326111acBbb618E028723e2EA2",
    registry: "0x32aAeC7768adBBFD65C776b129616b8727d0c8bd",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorer: "https://sepolia.arbiscan.io",
    testnet: true,
    payBaseUrl: TESTNET_PAY_BASE_URL,
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

/** keccak256 of the SignedReceiptQuote type string; checked against the store on first use. */
export const SIGNED_RECEIPT_QUOTE_TYPEHASH = "0x4a7928d77530d97888f6efe88c593ec8b076b8fbeef7e747e09d3a1ee1786ffd";

/** USDC uses 6 decimals on every supported chain. */
export const USDC_DECIMALS = 6;
