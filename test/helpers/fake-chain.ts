/**
 * An in-memory model of the Nota store, registry and USDC behind a viem `custom` transport.
 * It answers the JSON-RPC calls the SDK makes so readRequest/createRequest/getReceipt run their
 * real code paths offline. The validation logic mirrors NotaReceiptStore._verifySignedReceiptQuoteWithSigner.
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  numberToHex,
  recoverTypedDataAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { erc20Abi, notaReceiptStoreAbi, purchaseRefRegistryAbi } from "../../src/abi.js";
import { NOTA_DEPLOYMENTS } from "../../src/addresses.js";
import { signedQuoteTypedData } from "../../src/typed-data.js";
import type { SignedReceiptQuote } from "../../src/types.js";

export interface FakeListing {
  seller: Address;
  listingHash: Hex;
  active: boolean;
  mode: number;
}

export interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

class RpcRevert extends Error {
  code = 3;
  data: Hex;
  constructor(data: Hex) {
    super("execution reverted");
    this.data = data;
  }
}

function revert(errorName: string): never {
  throw new RpcRevert(encodeErrorResult({ abi: notaReceiptStoreAbi, errorName: errorName as "InvalidParams" }));
}

export class FakeChain {
  chainId: number;
  deployment: (typeof NOTA_DEPLOYMENTS)[42161];
  blockNumber = 1_000n;
  timestamp = 1_800_000_000n;
  listings = new Map<bigint, FakeListing>();
  consumed = new Set<string>();
  logs: FakeLog[] = [];
  getLogsCalls: { address?: unknown; topics?: unknown; fromBlock?: unknown; toBlock?: unknown }[] = [];
  /** Runs just before validateSignedReceiptPurchase; used to simulate races. */
  beforeValidate?: (quote: SignedReceiptQuote) => void;
  /** Override what SETTLEMENT_TOKEN returns, to test the deployment check. */
  settlementTokenOverride?: Address;
  private nextListingId = 1n;
  private nextReceiptId = 1n;
  readonly client: PublicClient;

  constructor(chainId: 42161 | 8453 = 42161) {
    this.chainId = chainId;
    this.deployment = NOTA_DEPLOYMENTS[chainId] as (typeof NOTA_DEPLOYMENTS)[42161];
    this.client = createPublicClient({ transport: custom({ request: (args) => this.request(args) }, { retryCount: 0 }), pollingInterval: 10 }) as PublicClient;
  }

  addListing(seller: Address, listingHash: Hex = `0x${"ab".repeat(32)}`, active = true): bigint {
    const id = this.nextListingId++;
    this.listings.set(id, { seller, listingHash, active, mode: 1 });
    return id;
  }

  mine(blocks = 1n, seconds = 2n * blocks): void {
    this.blockNumber += blocks;
    this.timestamp += seconds;
  }

  /** Emit a ReceiptPurchasedV2 log, as a purchase on this store would, and consume the ref. */
  emitReceipt(fields: {
    seller: Address;
    buyer: Address;
    listingId: bigint;
    purchaseRef: Hex;
    amount: bigint;
    metadataHash: Hex;
    agentId?: Hex;
    address?: Address;
  }): FakeLog {
    this.consumed.add(fields.purchaseRef.toLowerCase());
    this.mine();
    const topics = encodeEventTopics({
      abi: notaReceiptStoreAbi,
      eventName: "ReceiptPurchasedV2",
      args: { seller: fields.seller, buyer: fields.buyer, purchaseRef: fields.purchaseRef },
    }) as Hex[];
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
      [this.nextReceiptId++, fields.listingId, fields.amount, fields.metadataHash, fields.agentId ?? zeroHash],
    );
    const log: FakeLog = {
      address: fields.address ?? this.deployment.store,
      topics,
      data,
      blockNumber: this.blockNumber,
      transactionHash: `0x${this.blockNumber.toString(16).padStart(64, "0")}`,
      logIndex: 0,
    };
    this.logs.push(log);
    return log;
  }

  private block(number: bigint) {
    const timestamp = this.timestamp - (this.blockNumber - number) * 2n;
    return {
      number: numberToHex(number),
      hash: `0x${number.toString(16).padStart(64, "0")}`,
      parentHash: zeroHash,
      timestamp: numberToHex(timestamp),
      transactions: [],
      logsBloom: `0x${"00".repeat(256)}`,
      gasLimit: "0x0",
      gasUsed: "0x0",
      miner: zeroAddress,
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      extraData: "0x",
      size: "0x0",
      stateRoot: zeroHash,
      transactionsRoot: zeroHash,
      receiptsRoot: zeroHash,
      sha3Uncles: zeroHash,
      uncles: [],
      mixHash: zeroHash,
    };
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(this.chainId);
      case "eth_blockNumber":
        return numberToHex(this.blockNumber);
      case "eth_getBlockByNumber": {
        const tag = p[0] as string;
        const number = tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized" ? this.blockNumber : BigInt(tag);
        return this.block(number);
      }
      case "eth_call": {
        const { to, data } = p[0] as { to: Address; data: Hex };
        return this.call(to, data);
      }
      case "eth_getLogs":
        return this.getLogs(p[0] as { address?: string; topics?: (Hex | Hex[] | null)[]; fromBlock?: Hex; toBlock?: Hex });
      default:
        throw new Error(`FakeChain: unsupported method ${method}`);
    }
  }

  private getLogs(filter: { address?: string; topics?: (Hex | Hex[] | null)[]; fromBlock?: Hex; toBlock?: Hex }) {
    this.getLogsCalls.push(filter);
    const from = filter.fromBlock ? BigInt(filter.fromBlock) : 0n;
    const to = filter.toBlock ? BigInt(filter.toBlock) : this.blockNumber;
    return this.logs
      .filter((log) => {
        if (filter.address && log.address.toLowerCase() !== filter.address.toLowerCase()) return false;
        if (log.blockNumber < from || log.blockNumber > to) return false;
        return (filter.topics ?? []).every((topic, i) => {
          if (topic === null || topic === undefined) return true;
          const options = Array.isArray(topic) ? topic : [topic];
          return options.some((t) => t.toLowerCase() === log.topics[i]?.toLowerCase());
        });
      })
      .map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: numberToHex(log.blockNumber),
        transactionHash: log.transactionHash,
        transactionIndex: "0x0",
        blockHash: `0x${log.blockNumber.toString(16).padStart(64, "0")}`,
        logIndex: numberToHex(log.logIndex),
        removed: false,
      }));
  }

  private async call(to: Address, data: Hex): Promise<Hex> {
    const target = to.toLowerCase();
    if (target === this.deployment.registry.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: purchaseRefRegistryAbi, data });
      if (functionName === "isConsumed") {
        return encodeFunctionResult({ abi: purchaseRefRegistryAbi, functionName, result: this.consumed.has((args[0] as Hex).toLowerCase()) });
      }
      throw new Error(`FakeChain: registry.${functionName} not modelled`);
    }
    if (target === this.deployment.usdc.toLowerCase()) {
      const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
      if (functionName === "balanceOf" || functionName === "allowance") return encodeFunctionResult({ abi: erc20Abi, functionName, result: 0n });
      throw new Error(`FakeChain: usdc.${functionName} not modelled`);
    }
    if (target !== this.deployment.store.toLowerCase()) throw new RpcRevert("0x");

    const { functionName, args } = decodeFunctionData({ abi: notaReceiptStoreAbi, data });
    const encode = (result: unknown) => encodeFunctionResult({ abi: notaReceiptStoreAbi, functionName, result } as never);
    switch (functionName) {
      case "SETTLEMENT_TOKEN":
        return encode(this.settlementTokenOverride ?? this.deployment.usdc);
      case "PURCHASE_REF_REGISTRY":
        return encode(this.deployment.registry);
      case "EIP712_NAME":
        return encode("NotaReceiptStore");
      case "EIP712_VERSION":
        return encode("2");
      case "purchasesPaused":
        return encode(false);
      case "getListing": {
        const listing = this.listings.get(args[0] as bigint);
        if (!listing) revert("ListingNotFound");
        return encode({ ...listing, unitPrice: 0n });
      }
      case "validateSignedReceiptPurchase": {
        const [quote, signature, expectedBuyer] = args as unknown as [SignedReceiptQuote, Hex, Address, Address];
        this.beforeValidate?.(quote);
        const listing = this.listings.get(quote.listingId);
        if (!listing) revert("ListingNotFound");
        if (!listing.active) revert("ListingInactive");
        if (quote.buyer !== zeroAddress && quote.buyer.toLowerCase() !== expectedBuyer.toLowerCase()) revert("QuoteBuyerMismatch");
        if (quote.purchaseRef === zeroHash) revert("InvalidPurchaseRef");
        if (quote.metadataHash === zeroHash) revert("InvalidParams");
        if (quote.amount < 100n) revert("AmountOutOfBounds");
        if (quote.integratorFeeAmount !== 0n || quote.integratorFeeRecipient !== zeroAddress) revert("InvalidParams");
        if (quote.issuedAt > this.timestamp) revert("InvalidParams");
        if (quote.expiresAt <= quote.issuedAt) revert("InvalidParams");
        if (quote.expiresAt <= this.timestamp) revert("QuoteExpired");
        if (quote.expiresAt - quote.issuedAt > 86_400n) revert("QuoteExpiryTooLong");
        if (this.consumed.has(quote.purchaseRef.toLowerCase())) revert("PurchaseRefAlreadyUsed");
        let signer: Address;
        try {
          signer = await recoverTypedDataAddress({
            ...signedQuoteTypedData(quote, {
              chainId: this.chainId,
              store: this.deployment.store,
              settlementToken: this.deployment.usdc,
              purchaseRefRegistry: this.deployment.registry,
              seller: listing.seller,
            }),
            signature,
          });
        } catch {
          revert("InvalidQuoteSigner");
        }
        if (signer.toLowerCase() !== listing.seller.toLowerCase()) revert("InvalidQuoteSigner");
        return encode({
          grossAmount: quote.amount,
          protocolFee: 0n,
          integratorFee: 0n,
          sellerNet: quote.amount,
          protocolFeeRecipient: zeroAddress,
          integratorFeeRecipient: zeroAddress,
          seller: listing.seller,
          listingHash: listing.listingHash,
          verifiedSigner: signer,
        });
      }
      default:
        throw new Error(`FakeChain: store.${functionName} not modelled`);
    }
  }
}
