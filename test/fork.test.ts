/**
 * Fork tests against the real deployed contracts, via a local anvil fork. Nothing is broadcast to
 * the forked network. Skipped (reported as skipped) unless ARBITRUM_RPC_URL / BASE_RPC_URL is set.
 */
import { createWalletClient, getAddress, http, keccak256, stringToBytes, zeroAddress, zeroHash, type Address, type Chain, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NOTA_DEPLOYMENTS,
  createRequest,
  encodeRequest,
  erc20Abi,
  getReceipt,
  hashCheckoutMetadata,
  hashPurchaseRef,
  notaReceiptStoreAbi,
  payRequest,
  readRequest,
  setup,
  signedQuoteTypedData,
  waitForReceipt,
  type CheckoutMetadata,
  type CreateRequestResult,
  type NotaDeployment,
  type SignedReceiptQuote,
} from "../src/index.js";
import { startFork, dealErc20, type AnvilFork } from "./helpers/anvil.js";

const suites: { name: string; chain: Chain; rpcEnv: string; hasAttestReceipt: boolean }[] = [
  { name: "Arbitrum One", chain: arbitrum, rpcEnv: "ARBITRUM_RPC_URL", hasAttestReceipt: true },
  // Base runs the bb6935e build, which predates attestReceipt.
  { name: "Base", chain: base, rpcEnv: "BASE_RPC_URL", hasAttestReceipt: false },
];

for (const suite of suites) {
  const forkUrl = process.env[suite.rpcEnv];

  describe.skipIf(!forkUrl)(`fork: ${suite.name}`, () => {
    const deployment: NotaDeployment = NOTA_DEPLOYMENTS[suite.chain.id as 42161 | 8453];
    const sellerAccount = privateKeyToAccount(generatePrivateKey());
    const strangerAccount = privateKeyToAccount(generatePrivateKey());
    const payer: Address = getAddress("0x00000000000000000000000000000000fa1d0001");
    const payer2: Address = getAddress("0x00000000000000000000000000000000fa1d0002");
    let fork: AnvilFork;
    let sellerWallet: WalletClient;
    let strangerWallet: WalletClient;
    let payerWallet: WalletClient;
    let payer2Wallet: WalletClient;
    let listingId: bigint;
    let strangerListingId: bigint;
    let paid: CreateRequestResult;
    let paidBlock: bigint;

    const usdcBalance = (holder: Address) =>
      fork.publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    const request = (overrides: Partial<Parameters<typeof createRequest>[0]> = {}) =>
      createRequest({
        account: sellerAccount,
        publicClient: fork.publicClient,
        listingId,
        amount: 100_000n,
        purpose: "Fork test: one fee-history query",
        ...overrides,
      } as Parameters<typeof createRequest>[0]);

    beforeAll(async () => {
      fork = await startFork(forkUrl!, suite.chain);
      const transport = http(fork.rpcUrl, { retryCount: 3, timeout: 120_000 });
      sellerWallet = createWalletClient({ chain: suite.chain, account: sellerAccount, transport });
      strangerWallet = createWalletClient({ chain: suite.chain, account: strangerAccount, transport });
      payerWallet = createWalletClient({ chain: suite.chain, account: payer, transport });
      payer2Wallet = createWalletClient({ chain: suite.chain, account: payer2, transport });
      for (const address of [sellerAccount.address, strangerAccount.address, payer, payer2]) {
        await fork.testClient.setBalance({ address, value: 10n ** 18n });
      }
      await fork.testClient.impersonateAccount({ address: payer });
      await fork.testClient.impersonateAccount({ address: payer2 });
      await dealErc20(fork, deployment.usdc, payer, 1_000_000n);
      await dealErc20(fork, deployment.usdc, payer2, 1_000_000n);
      await dealErc20(fork, deployment.usdc, strangerAccount.address, 1_000_000n);
    });

    afterAll(async () => {
      await fork?.stop();
    });

    it("store immutables match the address table", async () => {
      const read = (functionName: "SETTLEMENT_TOKEN" | "PURCHASE_REF_REGISTRY") =>
        fork.publicClient.readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName });
      expect((await read("SETTLEMENT_TOKEN")).toLowerCase()).toBe(deployment.usdc.toLowerCase());
      expect((await read("PURCHASE_REF_REGISTRY")).toLowerCase()).toBe(deployment.registry.toLowerCase());
    });

    it("setup creates a SignedQuoteOnly listing owned by the seller", async () => {
      const result = await setup({
        walletClient: sellerWallet,
        publicClient: fork.publicClient,
        listing: { schema: "nota.listing.metadata.v1", kind: "payment_request", title: "Fork test agent budget", currency: "USDC", decimals: 6 },
      });
      listingId = result.listingId;
      const listing = await fork.publicClient.readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName: "getListing", args: [listingId] });
      expect(listing.seller).toBe(sellerAccount.address);
      expect(listing.active).toBe(true);
      expect(listing.mode).toBe(1);
      expect(listing.listingHash).toBe(result.listingHash);
    });

    it("createRequest -> payable -> payRequest moves exactly the amount, store balance unchanged -> paid", async () => {
      paid = await request();
      expect((await readRequest(paid.url, { publicClient: fork.publicClient })).status).toBe("payable");

      const [sellerBefore, storeBefore, payerBefore] = await Promise.all([usdcBalance(sellerAccount.address), usdcBalance(deployment.store), usdcBalance(payer)]);
      const result = await payRequest({ walletClient: payerWallet, publicClient: fork.publicClient, request: paid.url });
      const [sellerAfter, storeAfter, payerAfter] = await Promise.all([usdcBalance(sellerAccount.address), usdcBalance(deployment.store), usdcBalance(payer)]);

      expect(result.approveTxHash).toBeDefined();
      expect(sellerAfter - sellerBefore).toBe(100_000n);
      expect(storeAfter).toBe(storeBefore);
      expect(payerBefore - payerAfter).toBe(100_000n);
      const allowance = await fork.publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "allowance", args: [payer, deployment.store] });
      expect(allowance).toBe(0n);
      expect(result.receipt).toMatchObject({ seller: sellerAccount.address, payer, listingId, amount: 100_000n, purchaseRef: paid.purchaseRef });
      paidBlock = result.receipt.blockNumber;

      const read = await readRequest(paid.url, { publicClient: fork.publicClient });
      expect(read.status).toBe("paid");
      expect(read.receipt).toEqual(result.receipt);
      expect(await getReceipt({ publicClient: fork.publicClient, request: paid })).toEqual(result.receipt);
      expect(await waitForReceipt({ publicClient: fork.publicClient, request: paid.url, pollIntervalMs: 50 })).toEqual(result.receipt);
    });

    it("a second payRequest on the same link is refused", async () => {
      await expect(payRequest({ walletClient: payer2Wallet, publicClient: fork.publicClient, request: paid.url })).rejects.toMatchObject({
        code: "not_payable",
        details: { status: "paid" },
      });
    });

    it("a missing or late fromBlock hint reads as blocked, never paid", async () => {
      const { fromBlock: _drop, ...noHint } = paid;
      expect((await readRequest(noHint, { publicClient: fork.publicClient })).status).toBe("blocked");
      expect((await readRequest({ ...paid, fromBlock: paidBlock + 1n }, { publicClient: fork.publicClient })).status).toBe("blocked");
    });

    it("skips the approval when the allowance already covers the amount", async () => {
      const r = await request({ amount: 250n });
      await payer2Wallet.writeContract({ chain: suite.chain, account: payer2, address: deployment.usdc, abi: erc20Abi, functionName: "approve", args: [deployment.store, 250n] });
      const result = await payRequest({ walletClient: payer2Wallet, publicClient: fork.publicClient, request: r.url });
      expect(result.approveTxHash).toBeUndefined();
      expect(result.receipt.amount).toBe(250n);
    });

    it("an expired link is refused", async () => {
      const r = await request({ expiresInSeconds: 60 });
      await fork.testClient.increaseTime({ seconds: 61 });
      await fork.testClient.mine({ blocks: 1 });
      expect((await readRequest(r.url, { publicClient: fork.publicClient })).status).toBe("expired");
      await expect(payRequest({ walletClient: payerWallet, publicClient: fork.publicClient, request: r.url })).rejects.toMatchObject({
        details: { status: "expired" },
      });
    });

    it("a tampered link is refused", async () => {
      const r = await request();
      const tampered = encodeRequest({ ...r, quote: { ...r.quote, amount: 100n } });
      expect((await readRequest(tampered, { publicClient: fork.publicClient })).status).toBe("tampered");
      await expect(payRequest({ walletClient: payerWallet, publicClient: fork.publicClient, request: tampered })).rejects.toMatchObject({
        details: { status: "tampered" },
      });
    });

    it("a link pointing at another store is refused", async () => {
      const r = await request();
      const swapped = encodeRequest({ ...r, store: "0x000000000000000000000000000000000000dEaD" });
      expect((await readRequest(swapped, { publicClient: fork.publicClient })).status).toBe("unknown_store");
    });

    async function expectBlocked(r: CreateRequestResult) {
      expect((await readRequest(r.url, { publicClient: fork.publicClient })).status).toBe("blocked");
      await expect(getReceipt({ publicClient: fork.publicClient, request: r })).rejects.toMatchObject({ code: "purchase_ref_blocked" });
      await expect(waitForReceipt({ publicClient: fork.publicClient, request: r.url, pollIntervalMs: 20, blockedRetries: 1 })).rejects.toMatchObject({
        code: "purchase_ref_blocked",
      });
      await expect(payRequest({ walletClient: payerWallet, publicClient: fork.publicClient, request: r.url })).rejects.toMatchObject({
        code: "not_payable",
        details: { status: "blocked" },
      });
    }

    it("griefing setup: a third party owns a listing", async () => {
      const result = await setup({ walletClient: strangerWallet, publicClient: fork.publicClient, listing: { title: "Not the seller" } });
      strangerListingId = result.listingId;
    });

    it.runIf(suite.hasAttestReceipt)("griefing: a third party attests the ref from their own listing -> blocked", async () => {
      const victim = await request();
      await strangerWallet.writeContract({
        chain: suite.chain,
        account: strangerAccount,
        address: deployment.store,
        abi: notaReceiptStoreAbi,
        functionName: "attestReceipt",
        args: [strangerListingId, zeroAddress, victim.purchaseRef, keccak256(stringToBytes("grief")), zeroHash, zeroHash],
      });
      await expectBlocked(victim);
    });

    it("griefing: a third party buys the ref on their own listing -> blocked", async () => {
      const victim = await request();
      const block = await fork.publicClient.getBlock();
      const metadata = { schema: "nota.checkout.metadata.v1", note: "grief" } as unknown as CheckoutMetadata;
      const quote: SignedReceiptQuote = {
        listingId: strangerListingId,
        buyer: zeroAddress,
        purchaseRef: victim.purchaseRef,
        amount: 100n,
        metadataHash: hashCheckoutMetadata(metadata),
        agentId: zeroHash,
        integratorFeeRecipient: zeroAddress,
        integratorFeeAmount: 0n,
        issuedAt: block.timestamp,
        expiresAt: block.timestamp + 600n,
      };
      const signature: Hex = await strangerAccount.signTypedData(
        signedQuoteTypedData(quote, {
          chainId: deployment.chainId,
          store: deployment.store,
          settlementToken: deployment.usdc,
          purchaseRefRegistry: deployment.registry,
          seller: strangerAccount.address,
        }),
      );
      await strangerWallet.writeContract({ chain: suite.chain, account: strangerAccount, address: deployment.usdc, abi: erc20Abi, functionName: "approve", args: [deployment.store, 100n] });
      await strangerWallet.writeContract({
        chain: suite.chain,
        account: strangerAccount,
        address: deployment.store,
        abi: notaReceiptStoreAbi,
        functionName: "purchaseSignedReceipt",
        args: [quote, signature, zeroAddress],
      });
      await expectBlocked(victim);
    });

    it("purchaseRef derivation matches the deployed hashPurchaseRef", async () => {
      const nonce = `0x${"5a".repeat(32)}` as Hex;
      const onChain = await fork.publicClient.readContract({
        address: deployment.store,
        abi: notaReceiptStoreAbi,
        functionName: "hashPurchaseRef",
        args: [sellerAccount.address, listingId, "fork_ref", nonce],
      });
      expect(hashPurchaseRef({ chainId: deployment.chainId, settlementToken: deployment.usdc, seller: sellerAccount.address, rawPurchaseRef: "fork_ref", nonce })).toBe(onChain);
    });
  });
}
