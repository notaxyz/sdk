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
import { NOTA_DEPLOYMENTS, SIGNED_RECEIPT_QUOTE_TYPEHASH } from "../../src/addresses.js";
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
  /** Override what SIGNED_RECEIPT_QUOTE_TYPEHASH returns, to test the deployment check. */
  typehashOverride?: Hex;
  usdcBalances = new Map<string, bigint>();
  /** Authorized quote signers per listing (lowercase addresses). */
  quoteSigners = new Map<bigint, Set<string>>();
  /** Allowance of `owner` for the store, keyed by lowercase owner. */
  usdcAllowances = new Map<string, bigint>();
  private nextListingId = 1n;
  private nextReceiptId = 1n;
  readonly client: PublicClient;

  constructor(chainId: 42161 | 8453 | 421614 = 42161) {
    this.chainId = chainId;
    this.deployment = NOTA_DEPLOYMENTS[chainId] as (typeof NOTA_DEPLOYMENTS)[42161];
    this.client = createPublicClient({ transport: custom({ request: (args) => this.request(args) }, { retryCount: 0 }), pollingInterval: 10 }) as PublicClient;
  }

  addListing(seller: Address, listingHash: Hex = `0x${"ab".repeat(32)}`, active = true): bigint {
    const id = this.nextListingId++;
    this.listings.set(id, { seller, listingHash, active, mode: 1 });
    return id;
  }

  authorizeSigner(listingId: bigint, signer: Address, authorized = true): void {
    const set = this.quoteSigners.get(listingId) ?? new Set<string>();
    if (authorized) set.add(signer.toLowerCase());
    else set.delete(signer.toLowerCase());
    this.quoteSigners.set(listingId, set);
  }

  private isSigner(listingId: bigint, signer: Address): boolean {
    const listing = this.listings.get(listingId);
    if (!listing) return false;
    return signer.toLowerCase() === listing.seller.toLowerCase() || (this.quoteSigners.get(listingId)?.has(signer.toLowerCase()) ?? false);
  }

  /**
   * Block timestamps. Blocks up to the starting head are "history": one per 12 hours back from the
   * starting timestamp, so blocks 0 and 1 are years older than any request. Mined blocks are
   * recorded in segments with their own spacing.
   */
  private readonly startBlock = 1_000n;
  private readonly startTimestamp = 1_800_000_000n;
  private segments: { first: bigint; last: bigint; lastTimestamp: bigint; secondsPerBlock: bigint }[] = [];

  mine(blocks = 1n, seconds = 2n * blocks): void {
    this.segments.push({ first: this.blockNumber + 1n, last: this.blockNumber + blocks, lastTimestamp: this.timestamp + seconds, secondsPerBlock: seconds / blocks });
    this.blockNumber += blocks;
    this.timestamp += seconds;
  }

  timestampOf(number: bigint): bigint {
    if (number <= this.startBlock) return this.startTimestamp - (this.startBlock - number) * 43_200n;
    const segment = this.segments.find((seg) => number >= seg.first && number <= seg.last)!;
    return segment.lastTimestamp - (segment.last - number) * segment.secondsPerBlock;
  }

  /** Every JSON-RPC call this chain has served, by method. */
  rpcCalls: string[] = [];
  /** Serve the pre-approval allowance to this many upcoming purchase simulations (a lagging RPC node). */
  staleAllowanceCalls = 0;
  /** Purchase simulations served (eth_call of purchaseSignedReceipt). */
  purchaseSimulations = 0;
  private preApproveAllowance = new Map<string, bigint>();

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
    if (number < 0n || number > this.blockNumber) return null;
    const timestamp = this.timestampOf(number);
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
    this.rpcCalls.push(method);
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
        const { to, data, from } = p[0] as { to: Address; data: Hex; from?: Address };
        return this.call(to, data, from);
      }
      case "eth_sendTransaction":
        return this.sendTransaction(p[0] as { from: Address; to: Address; data: Hex });
      case "eth_getTransactionReceipt":
        return this.transactionReceipt(p[0] as Hex);
      case "eth_getTransactionByHash":
        return null;
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

  /** Mirrors NotaReceiptStore._verifySignedReceiptQuoteWithSigner. */
  private async verifyQuote(quote: SignedReceiptQuote, signature: Hex, expectedBuyer: Address, claimedSigner: Address) {
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
    const claimed = claimedSigner === zeroAddress ? listing.seller : claimedSigner;
    if (!this.isSigner(quote.listingId, claimed)) revert("InvalidQuoteSigner");
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
    if (signer.toLowerCase() !== claimed.toLowerCase()) revert("InvalidQuoteSigner");
    return { listing, signer };
  }

  private async checkPurchase(from: Address, quote: SignedReceiptQuote, signature: Hex, claimedSigner: Address, allowanceOverride?: bigint) {
    const verified = await this.verifyQuote(quote, signature, from, claimedSigner);
    const payer = from.toLowerCase();
    // Mirrors SafeERC20.safeTransferFrom failing on allowance or balance.
    if ((allowanceOverride ?? this.usdcAllowances.get(payer) ?? 0n) < quote.amount || (this.usdcBalances.get(payer) ?? 0n) < quote.amount) throw new RpcRevert("0x");
    return verified;
  }

  /** Transactions sent through eth_sendTransaction, by hash. */
  sentTransactions = new Map<Hex, { from: Address; to: Address; blockNumber: bigint; logs: FakeLog[] }>();
  /** When set, the next eth_sendTransaction fails as if the user rejected it in their wallet. */
  rejectNextSend = false;

  private async sendTransaction(tx: { from: Address; to: Address; data: Hex }): Promise<Hex> {
    if (this.rejectNextSend) {
      this.rejectNextSend = false;
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    }
    const from = tx.from;
    const target = tx.to.toLowerCase();
    let logs: FakeLog[] = [];
    if (target === this.deployment.usdc.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (functionName !== "approve") throw new Error(`FakeChain: usdc.${functionName} tx not modelled`);
      if ((args[0] as Address).toLowerCase() === this.deployment.store.toLowerCase()) {
        this.preApproveAllowance.set(from.toLowerCase(), this.usdcAllowances.get(from.toLowerCase()) ?? 0n);
        this.usdcAllowances.set(from.toLowerCase(), args[1] as bigint);
      }
      this.mine();
    } else if (target === this.deployment.store.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: notaReceiptStoreAbi, data: tx.data });
      if (functionName !== "purchaseSignedReceipt") throw new Error(`FakeChain: store.${functionName} tx not modelled`);
      const [quote, signature, claimedSigner] = args as unknown as [SignedReceiptQuote, Hex, Address];
      const { listing } = await this.checkPurchase(from, quote, signature, claimedSigner);
      const payer = from.toLowerCase();
      this.usdcAllowances.set(payer, (this.usdcAllowances.get(payer) ?? 0n) - quote.amount);
      this.usdcBalances.set(payer, (this.usdcBalances.get(payer) ?? 0n) - quote.amount);
      const seller = listing.seller.toLowerCase();
      this.usdcBalances.set(seller, (this.usdcBalances.get(seller) ?? 0n) + quote.amount);
      logs = [
        this.emitReceipt({
          seller: listing.seller,
          buyer: from,
          listingId: quote.listingId,
          purchaseRef: quote.purchaseRef,
          amount: quote.amount,
          metadataHash: quote.metadataHash,
          agentId: quote.agentId,
        }),
      ];
    } else {
      throw new Error(`FakeChain: transaction to ${tx.to} not modelled`);
    }
    const hash = logs[0]?.transactionHash ?? (`0x${this.blockNumber.toString(16).padStart(64, "0")}` as Hex);
    this.sentTransactions.set(hash, { from, to: tx.to, blockNumber: this.blockNumber, logs });
    return hash;
  }

  private transactionReceipt(hash: Hex) {
    const tx = this.sentTransactions.get(hash);
    if (!tx) return null;
    const blockHash = `0x${tx.blockNumber.toString(16).padStart(64, "0")}`;
    return {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: numberToHex(tx.blockNumber),
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      contractAddress: null,
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: "0x2",
      logs: tx.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: numberToHex(log.blockNumber),
        blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: "0x0",
        logIndex: numberToHex(log.logIndex),
        removed: false,
      })),
    };
  }

  private async call(to: Address, data: Hex, from: Address = zeroAddress): Promise<Hex> {
    const target = to.toLowerCase();
    if (target === this.deployment.registry.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: purchaseRefRegistryAbi, data });
      if (functionName === "isConsumed") {
        return encodeFunctionResult({ abi: purchaseRefRegistryAbi, functionName, result: this.consumed.has((args[0] as Hex).toLowerCase()) });
      }
      throw new Error(`FakeChain: registry.${functionName} not modelled`);
    }
    if (target === this.deployment.usdc.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
      const owner = String(args?.[0]).toLowerCase();
      if (functionName === "balanceOf") return encodeFunctionResult({ abi: erc20Abi, functionName, result: this.usdcBalances.get(owner) ?? 0n });
      if (functionName === "allowance") {
        const spender = String(args?.[1]).toLowerCase();
        const result = spender === this.deployment.store.toLowerCase() ? (this.usdcAllowances.get(owner) ?? 0n) : 0n;
        return encodeFunctionResult({ abi: erc20Abi, functionName, result });
      }
      if (functionName === "approve") return encodeFunctionResult({ abi: erc20Abi, functionName, result: true });
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
      case "SIGNED_RECEIPT_QUOTE_TYPEHASH":
        return encode(this.typehashOverride ?? SIGNED_RECEIPT_QUOTE_TYPEHASH);
      case "purchasesPaused":
        return encode(false);
      case "getListing": {
        const listing = this.listings.get(args[0] as bigint);
        if (!listing) revert("ListingNotFound");
        return encode({ ...listing, unitPrice: 0n });
      }
      case "isQuoteSignerAuthorized": {
        const [listingId, signer] = args as unknown as [bigint, Address];
        if (!this.listings.has(listingId)) revert("ListingNotFound");
        return encode(this.isSigner(listingId, signer));
      }
      case "validateSignedReceiptPurchase": {
        const [quote, signature, expectedBuyer, claimedSigner] = args as unknown as [SignedReceiptQuote, Hex, Address, Address];
        this.beforeValidate?.(quote);
        const { listing, signer } = await this.verifyQuote(quote, signature, expectedBuyer, claimedSigner);
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
      case "purchaseSignedReceipt": {
        // Simulation only: same checks the transaction would make, no state change.
        const [quote, signature, claimedSigner] = args as unknown as [SignedReceiptQuote, Hex, Address];
        this.purchaseSimulations++;
        let stale: bigint | undefined;
        if (this.staleAllowanceCalls > 0) {
          this.staleAllowanceCalls--;
          stale = this.preApproveAllowance.get(from.toLowerCase()) ?? 0n;
        }
        await this.checkPurchase(from, quote, signature, claimedSigner, stale);
        return encode(this.nextReceiptId);
      }
      default:
        throw new Error(`FakeChain: store.${functionName} not modelled`);
    }
  }
}
