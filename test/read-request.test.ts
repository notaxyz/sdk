import { createWalletClient, custom, decodeFunctionData, getAddress, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createRequest,
  decodeRequest,
  encodeRequest,
  erc20Abi,
  getReceipt,
  isNotaError,
  notaReceiptStoreAbi,
  payRequest,
  preparePayCalls,
  readRequest,
  signedQuoteTypedData,
  toLinkPayload,
  waitForReceipt,
  type CreateRequestResult,
  type PaymentRequest,
} from "../src/index.js";
import { hashCheckoutMetadata } from "../src/metadata.js";
import { FakeChain } from "./helpers/fake-chain.js";

const seller = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const payer = getAddress("0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8");

let chain: FakeChain;
let listingId: bigint;
let created: CreateRequestResult;

async function newRequest(overrides: Partial<Parameters<typeof createRequest>[0]> = {}) {
  return createRequest({
    account: seller,
    publicClient: chain.client,
    listingId,
    amount: 100_000n,
    purpose: "Buy one fee-history query",
    ...overrides,
  } as Parameters<typeof createRequest>[0]);
}

function receiptFieldsFor(request: PaymentRequest) {
  return {
    seller: seller.address,
    buyer: payer,
    listingId: request.quote.listingId,
    purchaseRef: request.quote.purchaseRef,
    amount: request.quote.amount,
    metadataHash: request.quote.metadataHash,
    agentId: request.quote.agentId,
  };
}

/** Re-sign a modified request as the real seller, so only the intended defect remains. */
async function resign(request: PaymentRequest, signer = seller): Promise<PaymentRequest> {
  const signature = await signer.signTypedData(
    signedQuoteTypedData(request.quote, {
      chainId: chain.chainId,
      store: chain.deployment.store,
      settlementToken: chain.deployment.usdc,
      purchaseRefRegistry: chain.deployment.registry,
      seller: request.metadata.seller,
    }),
  );
  return { ...request, signature };
}

beforeEach(async () => {
  chain = new FakeChain();
  listingId = chain.addListing(seller.address);
  created = await newRequest();
});

describe("createRequest", () => {
  it("produces a payable, decodable link with an unbound quote", async () => {
    expect(created.url.startsWith("https://usenota.xyz/pay#r=")).toBe(true);
    expect(created.quote.buyer).toBe("0x0000000000000000000000000000000000000000");
    expect(created.quote.integratorFeeAmount).toBe(0n);
    expect(created.quote.metadataHash).toBe(hashCheckoutMetadata(created.metadata));
    expect(created.metadata.checkout.title).toBe("Buy one fee-history query");
    expect(created.metadata.checkout.description).toBe("Buy one fee-history query");
    expect(created.metadata.quote.buyer).toBe("0x0000000000000000000000000000000000000000");
    expect(created.fromBlock).toBe(chain.blockNumber);
    expect(decodeRequest(created.url)).toEqual(decodeRequest(toLinkPayload(created)));
    const read = await readRequest(created.url, { publicClient: chain.client });
    expect(read.status).toBe("payable");
  });

  it("takes issuedAt from the latest block timestamp, not the local clock", () => {
    expect(created.quote.issuedAt).toBe(chain.timestamp);
    expect(created.quote.expiresAt - created.quote.issuedAt).toBe(3600n);
  });

  it("works with a walletClient as the signer", async () => {
    const walletClient = createWalletClient({ account: seller, transport: custom({ request: (a) => chain.request(a) }, { retryCount: 0 }) });
    const viaWallet = await createRequest({ walletClient, publicClient: chain.client, listingId, amount: 100n, purpose: "x" });
    expect((await readRequest(viaWallet.url, { publicClient: chain.client })).status).toBe("payable");
  });

  it.each([
    [{ amount: 99n }, /at least 100/],
    [{ expiresInSeconds: 86_401 }, /expiresInSeconds/],
    [{ expiresInSeconds: 0 }, /expiresInSeconds/],
    [{ expiresInSeconds: 1.5 }, /expiresInSeconds/],
    [{ rawPurchaseRef: "x".repeat(129) }, /1 to 128/],
    [{ rawPurchaseRef: "" }, /1 to 128/],
    [{ purpose: "   " }, /purpose/],
    [{ agentId: "0x1234" as Hex }, /agentId/],
    [{ listingId: 0n }, /listingId/],
  ])("rejects contract-limit violations client-side: %o", async (overrides, message) => {
    await expect(newRequest(overrides)).rejects.toThrow(message);
  });

  it("accepts the limits themselves", async () => {
    const r = await newRequest({ amount: 100n, expiresInSeconds: 86_400, rawPurchaseRef: "x".repeat(128) });
    expect((await readRequest(r.url, { publicClient: chain.client })).status).toBe("payable");
  });

  it("refuses to sign for someone else's or an inactive listing", async () => {
    await expect(newRequest({ account: stranger })).rejects.toMatchObject({ code: "not_listing_seller" });
    chain.listings.get(listingId)!.active = false;
    await expect(newRequest()).rejects.toMatchObject({ code: "listing_inactive" });
    await expect(newRequest({ listingId: 99n })).rejects.toMatchObject({ code: "listing_not_found" });
  });

  it("checks the store's quote typehash", async () => {
    const bad = new FakeChain();
    bad.addListing(seller.address);
    bad.typehashOverride = `0x${"00".repeat(32)}`;
    await expect(
      createRequest({ account: seller, publicClient: bad.client, listingId: 1n, amount: 100n, purpose: "x" }),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });

  it("works on Arbitrum Sepolia", async () => {
    const sepolia = new FakeChain(421614);
    const id = sepolia.addListing(seller.address);
    const r = await createRequest({ account: seller, publicClient: sepolia.client, listingId: id, amount: 100n, purpose: "testnet" });
    expect(r.chainId).toBe(421614);
    expect(r.store).toBe("0x6b13e2077c84e1326111acBbb618E028723e2EA2");
    expect(r.metadata.protocol.settlementToken).toBe("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d");
    expect((await readRequest(r.url, { publicClient: sepolia.client })).status).toBe("payable");
    expect((await readRequest(r.url, { publicClient: chain.client })).status).toBe("wrong_chain");
  });

  it("checks the store's immutables against the address table", async () => {
    const bad = new FakeChain();
    bad.addListing(seller.address);
    bad.settlementTokenOverride = "0x0000000000000000000000000000000000000001";
    await expect(
      createRequest({ account: seller, publicClient: bad.client, listingId: 1n, amount: 100n, purpose: "x" }),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });
});

describe("readRequest statuses", () => {
  it("unknown_store: a link never chooses the contract", async () => {
    const otherStore = { ...created, store: getAddress("0x000000000000000000000000000000000000dEaD") };
    expect((await readRequest(otherStore, { publicClient: chain.client })).status).toBe("unknown_store");
    const otherChain = { ...created, chainId: 1 };
    expect((await readRequest(otherChain, { publicClient: chain.client })).status).toBe("unknown_store");
  });

  it("wrong_chain", async () => {
    const base = new FakeChain(8453);
    expect((await readRequest(created.url, { publicClient: base.client })).status).toBe("wrong_chain");
  });

  it("tampered: metadata text edited", async () => {
    const edited = structuredClone(toLinkPayload(created));
    edited.metadata.checkout.description = "Something else";
    expect((await readRequest(edited, { publicClient: chain.client })).status).toBe("tampered");
  });

  it("tampered: quote amount edited (even if re-signed by the seller, metadata disagrees)", async () => {
    const edited = { ...created, quote: { ...created.quote, amount: 1n } };
    expect((await readRequest(edited, { publicClient: chain.client })).status).toBe("tampered");
    const resigned = await resign({ ...created, quote: { ...created.quote, amount: 200_000n } });
    expect((await readRequest(resigned, { publicClient: chain.client })).status).toBe("tampered");
  });

  it("tampered: metadata consistent with itself but not with the chain or quote", async () => {
    for (const mutate of [
      (m: PaymentRequest["metadata"]) => (m.protocol.chainId = 8453),
      (m: PaymentRequest["metadata"]) => (m.protocol.settlementToken = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")),
      (m: PaymentRequest["metadata"]) => (m.listing.listingId = "2"),
      (m: PaymentRequest["metadata"]) => (m.quote.purchaseRef = `0x${"11".repeat(32)}`),
    ]) {
      const metadata = structuredClone(created.metadata);
      mutate(metadata);
      const quote = { ...created.quote, metadataHash: hashCheckoutMetadata(metadata) };
      const request = await resign({ ...created, metadata, quote });
      expect((await readRequest(request, { publicClient: chain.client })).status).toBe("tampered");
    }
  });

  it("tampered: bound buyer or integrator fee", async () => {
    const bound = await resign({ ...created, quote: { ...created.quote, buyer: payer } });
    expect((await readRequest(bound, { publicClient: chain.client })).status).toBe("tampered");
    const fee = await resign({ ...created, quote: { ...created.quote, integratorFeeAmount: 1n, integratorFeeRecipient: payer } });
    expect((await readRequest(fee, { publicClient: chain.client })).status).toBe("tampered");
  });

  it("tampered: listingHash differs from the on-chain listing", async () => {
    chain.listings.get(listingId)!.listingHash = `0x${"cd".repeat(32)}`;
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("tampered");
  });

  it("invalid_signature: signed by someone other than the listing seller", async () => {
    const forged = await resign(created, stranger);
    expect((await readRequest(forged, { publicClient: chain.client })).status).toBe("invalid_signature");
    const garbage = { ...created, signature: `0x${"00".repeat(65)}` as Hex };
    expect((await readRequest(garbage, { publicClient: chain.client })).status).toBe("invalid_signature");
  });

  it("invalid_signature: metadata names a seller who does not own the listing", async () => {
    chain.listings.get(listingId)!.seller = stranger.address;
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("invalid_signature");
  });

  it("listing_inactive", async () => {
    chain.listings.get(listingId)!.active = false;
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("listing_inactive");
    chain.listings.delete(listingId);
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("listing_inactive");
  });

  it("expired: judged by chain time", async () => {
    chain.mine(1n, 3599n);
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("payable");
    chain.mine(1n, 1n);
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("expired");
  });

  it("paid: only with a matching ReceiptPurchasedV2 log", async () => {
    const log = chain.emitReceipt(receiptFieldsFor(created));
    const read = await readRequest(created.url, { publicClient: chain.client });
    expect(read.status).toBe("paid");
    expect(read.receipt).toMatchObject({ payer, amount: 100_000n, txHash: log.transactionHash, receiptId: 1n });
    const call = chain.getLogsCalls.at(-1)!;
    expect(call.address).toBe(chain.deployment.store);
    const topics = call.topics as (string | null)[];
    expect(topics[1]?.toLowerCase()).toContain(seller.address.slice(2).toLowerCase());
    expect(topics[3]).toBe(created.quote.purchaseRef);
  });

  it("paid stays paid after the listing is deactivated or the quote expires", async () => {
    chain.emitReceipt(receiptFieldsFor(created));
    chain.listings.get(listingId)!.active = false;
    chain.mine(1n, 100_000n);
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("paid");
  });
});

describe("consumed is never paid", () => {
  it("blocked: ref consumed with no receipt (attestReceipt-style)", async () => {
    chain.consumed.add(created.quote.purchaseRef);
    chain.mine();
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("blocked");
    await expect(getReceipt({ publicClient: chain.client, request: created })).rejects.toMatchObject({ code: "purchase_ref_blocked" });
    await expect(
      waitForReceipt({ publicClient: chain.client, request: created, pollIntervalMs: 1, blockedRetries: 2 }),
    ).rejects.toMatchObject({ code: "purchase_ref_blocked" });
  });

  it("blocked: a third party bought the ref on their own listing", async () => {
    const theirListing = chain.addListing(stranger.address);
    chain.emitReceipt({ ...receiptFieldsFor(created), seller: stranger.address, listingId: theirListing });
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("blocked");
    await expect(getReceipt({ publicClient: chain.client, request: created })).rejects.toMatchObject({ code: "purchase_ref_blocked" });
  });

  it.each([
    ["amount", { amount: 100_001n }],
    ["metadataHash", { metadataHash: `0x${"ee".repeat(32)}` as Hex }],
    ["listingId", { listingId: 7n }],
    ["agentId", { agentId: `0x${"01".repeat(32)}` as Hex }],
  ])("blocked: same seller and ref but different %s", async (_field, change) => {
    chain.emitReceipt({ ...receiptFieldsFor(created), ...change });
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("blocked");
  });

  it("blocked: a matching log from a different contract does not count", async () => {
    chain.consumed.add(created.quote.purchaseRef);
    chain.emitReceipt({ ...receiptFieldsFor(created), address: getAddress("0x000000000000000000000000000000000000bEEF") });
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("blocked");
  });

  it("the unsigned fromBlock hint can only downgrade paid to blocked", async () => {
    const log = chain.emitReceipt(receiptFieldsFor(created));
    const { fromBlock: _drop, ...noHint } = created;
    expect((await readRequest(noHint, { publicClient: chain.client })).status).toBe("blocked");
    const lateHint = { ...created, fromBlock: log.blockNumber + 1n };
    expect((await readRequest(lateHint, { publicClient: chain.client })).status).toBe("blocked");
    expect((await readRequest(noHint, { publicClient: chain.client, fromBlock: created.fromBlock })).status).toBe("paid");
    await expect(getReceipt({ publicClient: chain.client, request: noHint })).rejects.toMatchObject({ code: "purchase_ref_blocked" });
  });

  it("searches in bounded block ranges", async () => {
    chain.mine(12_000n, 60n);
    chain.emitReceipt(receiptFieldsFor(created));
    const before = chain.getLogsCalls.length;
    const receipt = await getReceipt({ publicClient: chain.client, request: created, maxBlockRange: 5_000n });
    expect(receipt?.payer).toBe(payer);
    const calls = chain.getLogsCalls.slice(before);
    expect(calls.length).toBe(3);
    for (const call of calls) expect(BigInt(call.toBlock as string) - BigInt(call.fromBlock as string)).toBeLessThan(5_000n);
  });

  it("race: validation reverts PurchaseRefAlreadyUsed and a matching receipt exists -> paid", async () => {
    chain.beforeValidate = () => {
      chain.beforeValidate = undefined;
      chain.emitReceipt(receiptFieldsFor(created));
    };
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("paid");
  });

  it("race: validation reverts PurchaseRefAlreadyUsed with no matching receipt -> blocked", async () => {
    chain.beforeValidate = (quote) => chain.consumed.add(quote.purchaseRef.toLowerCase());
    expect((await readRequest(created, { publicClient: chain.client })).status).toBe("blocked");
  });
});

describe("getReceipt / waitForReceipt", () => {
  it("getReceipt is null until paid, then the verified receipt", async () => {
    expect(await getReceipt({ publicClient: chain.client, request: created })).toBeNull();
    chain.emitReceipt(receiptFieldsFor(created));
    expect(await getReceipt({ publicClient: chain.client, request: created.url })).toMatchObject({ payer, purchaseRef: created.quote.purchaseRef });
  });

  it("waitForReceipt resolves when a matching receipt lands", async () => {
    setTimeout(() => chain.emitReceipt(receiptFieldsFor(created)), 30);
    const receipt = await waitForReceipt({ publicClient: chain.client, request: created, pollIntervalMs: 5, timeoutMs: 2_000 });
    expect(receipt.amount).toBe(100_000n);
  });

  it("waitForReceipt tolerates a log index that lags the consumed flag", async () => {
    chain.consumed.add(created.quote.purchaseRef);
    setTimeout(() => chain.emitReceipt(receiptFieldsFor(created)), 15);
    const receipt = await waitForReceipt({ publicClient: chain.client, request: created, pollIntervalMs: 10, blockedRetries: 5 });
    expect(receipt.payer).toBe(payer);
  });

  it("waitForReceipt times out", async () => {
    await expect(waitForReceipt({ publicClient: chain.client, request: created, pollIntervalMs: 5, timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

describe("preparePayCalls", () => {
  it("returns an exact-amount approve then the purchase when the allowance is short", async () => {
    chain.usdcBalances.set(payer.toLowerCase(), 100_000n);
    chain.usdcAllowances.set(payer.toLowerCase(), 99_999n);
    const { calls, needsApproval } = await preparePayCalls({ publicClient: chain.client, request: created.url, payer });
    expect(needsApproval).toBe(true);
    expect(calls.map((c) => c.to)).toEqual([chain.deployment.usdc, chain.deployment.store]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect(approve.args).toEqual([chain.deployment.store, 100_000n]);
    const purchase = decodeFunctionData({ abi: notaReceiptStoreAbi, data: calls[1]!.data });
    expect(purchase.functionName).toBe("purchaseSignedReceipt");
    expect(purchase.args).toEqual([created.quote, created.signature, zeroAddress]);
    expect(Object.keys(calls[0]!).sort()).toEqual(["data", "to"]);
  });

  it("returns only the purchase when the allowance already covers the amount", async () => {
    chain.usdcBalances.set(payer.toLowerCase(), 100_000n);
    chain.usdcAllowances.set(payer.toLowerCase(), 100_000n);
    const { calls, needsApproval } = await preparePayCalls({ publicClient: chain.client, request: created, payer });
    expect(needsApproval).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(chain.deployment.store);
  });

  it("checks the payer's balance", async () => {
    chain.usdcBalances.set(payer.toLowerCase(), 99_999n);
    await expect(preparePayCalls({ publicClient: chain.client, request: created, payer })).rejects.toMatchObject({ code: "insufficient_balance" });
  });

  it("refuses anything readRequest does not call payable", async () => {
    chain.usdcBalances.set(payer.toLowerCase(), 100_000n);
    chain.consumed.add(created.quote.purchaseRef);
    await expect(preparePayCalls({ publicClient: chain.client, request: created, payer })).rejects.toMatchObject({
      code: "not_payable",
      details: { status: "blocked" },
    });
    const tampered = { ...created, quote: { ...created.quote, amount: 5_000n } };
    await expect(preparePayCalls({ publicClient: chain.client, request: tampered, payer })).rejects.toMatchObject({
      details: { status: "tampered" },
    });
  });
});

describe("payRequest", () => {
  const walletFor = () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: custom({ request: (a) => chain.request(a) }, { retryCount: 0 }) });

  it.each([
    ["paid", () => chain.emitReceipt(receiptFieldsFor(created))],
    ["blocked", () => chain.consumed.add(created.quote.purchaseRef)],
    ["expired", () => chain.mine(1n, 4_000n)],
    ["listing_inactive", () => (chain.listings.get(listingId)!.active = false)],
  ])("refuses a %s request before sending anything", async (status, arrange) => {
    arrange();
    const error = await payRequest({ walletClient: walletFor(), publicClient: chain.client, request: created.url }).catch((e) => e);
    expect(isNotaError(error, "not_payable")).toBe(true);
    expect(error.details.status).toBe(status);
  });

  it("preparePayCalls refuses the same way", async () => {
    chain.emitReceipt(receiptFieldsFor(created));
    await expect(preparePayCalls({ publicClient: chain.client, request: created.url, payer })).rejects.toMatchObject({
      code: "not_payable",
      details: { status: "paid" },
    });
  });

  it("refuses a tampered link", async () => {
    const tampered = encodeRequest({ ...created, quote: { ...created.quote, amount: 1_000n } });
    await expect(payRequest({ walletClient: walletFor(), publicClient: chain.client, request: tampered })).rejects.toMatchObject({
      code: "not_payable",
      details: { status: "tampered" },
    });
  });
});
