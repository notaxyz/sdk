import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { decodeRequest, encodeRequest, toLinkPayload, type PaymentRequest } from "../src/index.js";

const sample: PaymentRequest = {
  chainId: 42161,
  store: "0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88",
  quote: {
    listingId: 12n,
    buyer: "0x0000000000000000000000000000000000000000",
    purchaseRef: `0x${"11".repeat(32)}`,
    amount: 123_456_789_012_345_678_901_234_567_890n,
    metadataHash: `0x${"22".repeat(32)}`,
    agentId: `0x${"00".repeat(32)}`,
    integratorFeeRecipient: "0x0000000000000000000000000000000000000000",
    integratorFeeAmount: 0n,
    issuedAt: 1_791_643_436n,
    expiresAt: 1_791_647_036n,
  },
  signature: `0x${"ab".repeat(65)}`,
  metadata: {
    schema: "nota.checkout.metadata.v1",
    protocol: {
      name: "Nota",
      version: "1",
      chainId: 42161,
      receiptStore: "0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88",
      settlementToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    seller: privateKeyToAccount(`0x${"01".repeat(32)}`).address,
    listing: { listingId: "12", listingHash: `0x${"33".repeat(32)}` },
    quote: {
      buyer: "0x0000000000000000000000000000000000000000",
      purchaseRef: `0x${"11".repeat(32)}`,
      amount: "123456789012345678901234567890",
      currency: "USDC",
      decimals: 6,
      issuedAt: 1_791_643_436,
      expiresAt: 1_791_647_036,
    },
    checkout: { kind: "payment_request", title: "Ünïcödé ✓ 🚀", description: "Ünïcödé ✓ 🚀 & more" },
  },
  fromBlock: 513_536_720n,
};

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("link format", () => {
  it("round-trips through a URL fragment", () => {
    const url = encodeRequest(sample, "https://example.com/pay");
    expect(url.startsWith("https://example.com/pay#r=")).toBe(true);
    expect(url.split("#r=")[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRequest(url)).toEqual(sample);
  });

  it("accepts URL, fragment, bare payload, payload object and request object", () => {
    const url = encodeRequest(sample);
    const encoded = url.split("#r=")[1]!;
    expect(decodeRequest(`#r=${encoded}`)).toEqual(sample);
    expect(decodeRequest(`r=${encoded}`)).toEqual(sample);
    expect(decodeRequest(encoded)).toEqual(sample);
    expect(decodeRequest(toLinkPayload(sample))).toEqual(sample);
    expect(decodeRequest(sample)).toEqual(sample);
  });

  it("serializes bigint as decimal strings with v: 1", () => {
    const json = JSON.parse(Buffer.from(encodeRequest(sample).split("#r=")[1]!, "base64url").toString("utf8"));
    expect(json.v).toBe(1);
    expect(json.quote.amount).toBe("123456789012345678901234567890");
    expect(json.quote.issuedAt).toBe("1791643436");
    expect(json.fromBlock).toBe("513536720");
  });

  it("omits fromBlock when absent", () => {
    const { fromBlock: _drop, ...noHint } = sample;
    const decoded = decodeRequest(encodeRequest(noHint));
    expect(decoded.fromBlock).toBeUndefined();
  });

  it("rejects unknown versions", () => {
    for (const v of [0, 2, "1", undefined]) {
      expect(() => decodeRequest(encodeJson({ ...toLinkPayload(sample), v }))).toThrow(/unsupported link version/);
    }
  });

  it("rejects malformed input", () => {
    const payload = toLinkPayload(sample);
    const cases: unknown[] = [
      { ...payload, extra: 1 },
      { ...payload, chainId: "42161" },
      { ...payload, store: "0x1234" },
      { ...payload, signature: "0x" },
      { ...payload, signature: "0xabc" },
      { ...payload, metadata: "x" },
      { ...payload, fromBlock: 5 },
      { ...payload, quote: { ...payload.quote, amount: "-1" } },
      { ...payload, quote: { ...payload.quote, amount: "01" } },
      { ...payload, quote: { ...payload.quote, amount: 5 } },
      { ...payload, quote: { ...payload.quote, issuedAt: (1n << 64n).toString() } },
      { ...payload, quote: { ...payload.quote, purchaseRef: "0x12" } },
      { ...payload, quote: { ...payload.quote, extra: "1" } },
      { ...payload, quote: (({ agentId: _a, ...rest }) => rest)(payload.quote) },
      [],
      null,
    ];
    for (const value of cases) expect(() => decodeRequest(encodeJson(value)), JSON.stringify(value)).toThrow(/Invalid payment link/);
    expect(() => decodeRequest("https://usenota.xyz/pay#r=%%%")).toThrow(/Invalid payment link/);
    expect(() => decodeRequest("https://usenota.xyz/pay#x=1")).toThrow(/no "r"/);
    expect(() => decodeRequest(Buffer.from("not json").toString("base64url"))).toThrow(/not valid JSON/);
    expect(() => decodeRequest(Buffer.from([0xff, 0xfe]).toString("base64url"))).toThrow(/base64url UTF-8/);
  });

  it("refuses a baseUrl that already has a fragment", () => {
    expect(() => encodeRequest(sample, "https://x.test/pay#a")).toThrow(/fragment/);
  });
});
