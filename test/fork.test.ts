/**
 * Fork tests against the real deployed contracts, via a local anvil fork. Nothing is broadcast to
 * the forked network. Skipped (reported as skipped) unless ARBITRUM_RPC_URL / BASE_RPC_URL is set.
 */
import { createWalletClient, getAddress, http, parseAbi, keccak256, stringToBytes, zeroAddress, zeroHash, type Address, type Chain, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia, base } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NOTA_DEPLOYMENTS,
  SIGNED_RECEIPT_QUOTE_TYPEHASH,
  authorizeSigner,
  createRequest,
  encodeRequest,
  erc20Abi,
  getReceipt,
  hashCheckoutMetadata,
  hashPurchaseRef,
  notaReceiptStoreAbi,
  payRequest,
  preparePayCalls,
  readRequest,
  revokeSigner,
  setup,
  signedQuoteTypedData,
  waitForReceipt,
  type CheckoutMetadata,
  type CreateRequestResult,
  type NotaDeployment,
  type PayStep,
  type SignedReceiptQuote,
} from "../src/index.js";
import { startFork, dealErc20, type AnvilFork } from "./helpers/anvil.js";

const suites: { name: string; chain: Chain; rpcEnv: string; hasAttestReceipt: boolean }[] = [
  { name: "Arbitrum One", chain: arbitrum, rpcEnv: "ARBITRUM_RPC_URL", hasAttestReceipt: true },
  // Base runs the bb6935e build, which predates attestReceipt.
  { name: "Base", chain: base, rpcEnv: "BASE_RPC_URL", hasAttestReceipt: false },
  // Testnet; same source as Arbitrum One (84ac4f6), including attestReceipt.
  { name: "Arbitrum Sepolia", chain: arbitrumSepolia, rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL", hasAttestReceipt: true },
];

for (const suite of suites) {
  const forkUrl = process.env[suite.rpcEnv];

  // Public RPCs can be slow to serve fork state on first touch.
  describe.skipIf(!forkUrl)(`fork: ${suite.name}`, { timeout: 120_000 }, () => {
    const deployment: NotaDeployment = NOTA_DEPLOYMENTS[suite.chain.id as 42161 | 8453 | 421614];
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

    it("store immutables, EIP-712 domain and quote typehash match the SDK", async () => {
      const read = (functionName: "SETTLEMENT_TOKEN" | "PURCHASE_REF_REGISTRY" | "SIGNED_RECEIPT_QUOTE_TYPEHASH") =>
        fork.publicClient.readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName });
      expect((await read("SETTLEMENT_TOKEN")).toLowerCase()).toBe(deployment.usdc.toLowerCase());
      expect((await read("PURCHASE_REF_REGISTRY")).toLowerCase()).toBe(deployment.registry.toLowerCase());
      expect(await read("SIGNED_RECEIPT_QUOTE_TYPEHASH")).toBe(SIGNED_RECEIPT_QUOTE_TYPEHASH);
      const [, name, version, chainId, verifyingContract] = await fork.publicClient.readContract({
        address: deployment.store,
        abi: parseAbi(["function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])"]),
        functionName: "eip712Domain",
      });
      expect([name, version, chainId, verifyingContract]).toEqual(["NotaReceiptStore", "2", BigInt(deployment.chainId), deployment.store]);
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
      const steps: PayStep[] = [];
      const result = await payRequest({ walletClient: payerWallet, publicClient: fork.publicClient, request: paid.url, onStep: (s) => steps.push(s) });
      expect(steps).toEqual([
        { step: "approve", state: "awaiting_signature" },
        { step: "approve", state: "submitted", txHash: result.approveTxHash },
        { step: "approve", state: "confirmed", txHash: result.approveTxHash },
        { step: "pay", state: "awaiting_signature" },
        { step: "pay", state: "submitted", txHash: result.payTxHash },
        { step: "pay", state: "confirmed", txHash: result.payTxHash },
      ]);
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
      const steps: PayStep[] = [];
      const result = await payRequest({ walletClient: payer2Wallet, publicClient: fork.publicClient, request: r.url, onStep: (s) => steps.push(s) });
      expect(result.approveTxHash).toBeUndefined();
      expect(steps.map((s) => `${s.step}:${s.state}`)).toEqual(["approve:skipped", "pay:awaiting_signature", "pay:submitted", "pay:confirmed"]);
      expect(result.receipt.amount).toBe(250n);
    });

    it("preparePayCalls output, sent as-is, pays the request (what a smart account would batch)", async () => {
      const r = await request({ amount: 777n });
      const { calls, needsApproval } = await preparePayCalls({ publicClient: fork.publicClient, request: r.url, payer: payer2 });
      expect(needsApproval).toBe(true);
      expect(calls).toHaveLength(2);
      const sellerBefore = await usdcBalance(sellerAccount.address);
      for (const call of calls) {
        const hash = await payer2Wallet.sendTransaction({ chain: suite.chain, account: payer2, to: call.to, data: call.data });
        expect((await fork.publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
      }
      expect((await usdcBalance(sellerAccount.address)) - sellerBefore).toBe(777n);
      const read = await readRequest(r.url, { publicClient: fork.publicClient });
      expect(read.status).toBe("paid");
      expect(read.receipt?.payer).toBe(payer2);
    });

    describe("authorized quote signer", () => {
      const delegate = privateKeyToAccount(generatePrivateKey());

      it("seller authorizes a signer; the signer's request is paid to the seller, not the signer", async () => {
        await expect(request({ account: delegate })).rejects.toMatchObject({ code: "not_authorized_signer" });
        await authorizeSigner({ walletClient: sellerWallet, publicClient: fork.publicClient, listingId, signer: delegate.address });
        const authorized = await fork.publicClient.readContract({
          address: deployment.store,
          abi: notaReceiptStoreAbi,
          functionName: "isQuoteSignerAuthorized",
          args: [listingId, delegate.address],
        });
        expect(authorized).toBe(true);

        const r = await request({ account: delegate, amount: 1_000n });
        const read = await readRequest(r.url, { publicClient: fork.publicClient });
        expect(read.status).toBe("payable");
        expect(read.request.seller).toBe(sellerAccount.address);
        expect(read.request.signer).toBe(delegate.address);

        const [sellerBefore, signerBefore, storeBefore] = await Promise.all([usdcBalance(sellerAccount.address), usdcBalance(delegate.address), usdcBalance(deployment.store)]);
        const result = await payRequest({ walletClient: payer2Wallet, publicClient: fork.publicClient, request: r.url });
        expect((await usdcBalance(sellerAccount.address)) - sellerBefore).toBe(1_000n);
        expect(await usdcBalance(delegate.address)).toBe(signerBefore);
        expect(await usdcBalance(deployment.store)).toBe(storeBefore);
        expect(result.receipt.seller).toBe(sellerAccount.address);
        expect(result.receipt.payer).toBe(payer2);
        expect((await readRequest(r.url, { publicClient: fork.publicClient })).status).toBe("paid");
      });

      it("a revoked signer's request reads invalid_signature and is refused", async () => {
        const r = await request({ account: delegate, amount: 1_000n });
        expect((await readRequest(r.url, { publicClient: fork.publicClient })).status).toBe("payable");
        await revokeSigner({ walletClient: sellerWallet, publicClient: fork.publicClient, listingId, signer: delegate.address });
        expect((await readRequest(r.url, { publicClient: fork.publicClient })).status).toBe("invalid_signature");
        await expect(payRequest({ walletClient: payer2Wallet, publicClient: fork.publicClient, request: r.url })).rejects.toMatchObject({
          code: "not_payable",
          details: { status: "invalid_signature" },
        });
        await expect(request({ account: delegate })).rejects.toMatchObject({ code: "not_authorized_signer" });
      });

      it("only the seller can authorize signers", async () => {
        await expect(
          authorizeSigner({ walletClient: strangerWallet, publicClient: fork.publicClient, listingId, signer: delegate.address }),
        ).rejects.toMatchObject({ code: "not_listing_seller" });
      });
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
