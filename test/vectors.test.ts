import { readFileSync } from "node:fs";

import { recoverTypedDataAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  NOTA_DEPLOYMENTS,
  canonicalize,
  hashCheckoutMetadata,
  hashPurchaseRef,
  quoteDigest,
  signedQuoteTypedData,
  type CheckoutMetadata,
  type SignedReceiptQuote,
} from "../src/index.js";

// Arbitrum One receipt #1: purchaseSignedReceipt tx
// 0xfd547ef4bacfb2f30cd40c57a14c97a47ab1ae67d0290f1122e795c8155eb986 (notaxyz/contracts
// broadcast/DemoPurchaseArbitrumOne.s.sol/42161/run-latest.json).
const arb = NOTA_DEPLOYMENTS[42161];
const SELLER = "0xF2E63f2339141A317e0f446Bf1d81593aBc5D557";
const BUYER = "0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8";
const PURCHASE_REF = "0x52d4d87226d848fb769289727d882f865cc4c3e3413a8c4fd10e2b2bf2279d9f";
const METADATA_HASH = "0x45d2b52ac1b5fc6411bc5b16aa3095f9c17df72ddf526258867bb8156e0d3798";
const SELLER_SIGNATURE: Hex =
  "0x62e02f67e67a8fe9b955db71ba790888b17f8b5309598845c76398f514b1910712074197145a4fc99224f6974ad72de4da9d1c1c747b1960173a90439475479e1c";

const realQuote: SignedReceiptQuote = {
  listingId: 1n,
  buyer: BUYER,
  purchaseRef: PURCHASE_REF,
  amount: 100_000n,
  metadataHash: METADATA_HASH,
  agentId: "0x0000000000000000000000000000000000000000000000000000000004c5506a",
  integratorFeeRecipient: "0x0000000000000000000000000000000000000000",
  integratorFeeAmount: 0n,
  issuedAt: 1791643436n,
  expiresAt: 1791647036n,
};

const context = {
  chainId: 42161,
  store: arb.store,
  settlementToken: arb.usdc,
  purchaseRefRegistry: arb.registry,
  seller: SELLER,
} as const;

describe("offline vectors from Arbitrum One receipt #1", () => {
  it("EIP-712 digest matches the broadcast purchase", () => {
    expect(quoteDigest(realQuote, context)).toBe("0x5d199c8b0a1d37b0b3345502c75f8c43c1def9a6d79fe96a702afc6b7a0f7d9e");
  });

  it("the on-chain seller signature recovers to the seller", async () => {
    const signer = await recoverTypedDataAddress({ ...signedQuoteTypedData(realQuote, context), signature: SELLER_SIGNATURE });
    expect(signer).toBe(SELLER);
  });

  it("purchaseRef matches the contract's hashPurchaseRef derivation", () => {
    expect(
      hashPurchaseRef({
        chainId: 42161,
        settlementToken: arb.usdc,
        seller: SELLER,
        rawPurchaseRef: "nota_demo_arbitrum_one_fee_history_query_v1",
        nonce: "0x07a396d2c47b62c6ff18d780f0e4f92fad1500472128cf3f6977e3ab8a7df5b7",
      }),
    ).toBe(PURCHASE_REF);
  });

  it("metadata hash of script/demo-metadata-arbitrum-one.json", () => {
    const raw = readFileSync(new URL("./fixtures/demo-metadata-arbitrum-one.json", import.meta.url), "utf8");
    const document = JSON.parse(raw) as CheckoutMetadata;
    expect(canonicalize(document)).toBe(raw.trimEnd());
    expect(hashCheckoutMetadata(document)).toBe(METADATA_HASH);
  });

  it("rawPurchaseRef must be 1..128 bytes", () => {
    const base = { chainId: 42161, settlementToken: arb.usdc, seller: SELLER, nonce: PURCHASE_REF } as const;
    expect(() => hashPurchaseRef({ ...base, rawPurchaseRef: "" })).toThrow(/1 to 128/);
    expect(() => hashPurchaseRef({ ...base, rawPurchaseRef: "x".repeat(129) })).toThrow(/1 to 128/);
    expect(() => hashPurchaseRef({ ...base, rawPurchaseRef: "é".repeat(65) })).toThrow(/1 to 128/);
    expect(hashPurchaseRef({ ...base, rawPurchaseRef: "x".repeat(128) })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("JCS", () => {
  it("sorts keys by UTF-16 code unit and drops undefined", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "é": 2, Z: undefined })).toBe('{"a":[true,null,"x"],"b":1,"é":2}');
  });

  it("serializes numbers like ECMAScript", () => {
    expect(canonicalize([1e21, 0.1, -0, 1791643436])).toBe("[1e+21,0.1,0,1791643436]");
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize({ a: 1n })).toThrow();
  });
});
