import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWalletClient, getAddress, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEMO_PURPOSE, createPaymentServer } from "../examples/mcp-server.js";
import { NOTA_DEPLOYMENTS, decodeRequest, payRequest, setup } from "../src/index.js";
import { dealErc20, startFork, type AnvilFork } from "./helpers/anvil.js";
import { FakeChain } from "./helpers/fake-chain.js";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const raw = result.content[0]!.text;
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // plain-text error message
  }
  return { isError: result.isError === true, body: body as Record<string, unknown> & string, raw };
}

describe("MCP server (offline, in-memory transport)", () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const payer = getAddress("0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8");
  let chain: FakeChain;
  let client: Client;

  beforeEach(async () => {
    chain = new FakeChain();
    const listingId = chain.addListing(signer.address);
    const server = createPaymentServer({ publicClient: chain.client, account: signer, listingId, deployment: chain.deployment, baseUrl: "http://localhost:3000/pay" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
  });

  const pay = async (requestUrl: string, overrides: { amount?: bigint } = {}) => {
    const request = decodeRequest(requestUrl);
    chain.emitReceipt({
      seller: signer.address,
      buyer: payer,
      listingId: request.quote.listingId,
      purchaseRef: request.quote.purchaseRef,
      amount: overrides.amount ?? request.quote.amount,
      metadataHash: request.quote.metadataHash,
      agentId: request.quote.agentId,
    });
  };

  it("lists the three tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_payment", "premium_fortune", "request_payment"]);
  });

  it("request_payment -> pending -> paid with receipt and explorer link", async () => {
    const created = await call(client, "request_payment", { amount: "0.10", purpose: "buy more searches" });
    expect(created.isError).toBe(false);
    expect(created.body.requestId).toMatch(/^req_[0-9a-f]{16}$/);
    expect(String(created.body.url)).toMatch(/^http:\/\/localhost:3000\/pay#r=/);
    expect(created.body.amountUsdc).toBe("0.1");
    expect(Date.parse(String(created.body.expiresAt))).toBe(Number(chain.timestamp + 3600n) * 1000);

    expect((await call(client, "check_payment", { request_id: created.body.requestId })).body.status).toBe("pending");
    await pay(String(created.body.url));
    const paid = await call(client, "check_payment", { request_id: created.body.requestId });
    expect(paid.body.status).toBe("paid");
    expect(paid.body.receipt).toMatchObject({ payer, receiptId: "1", amountUsdc: "0.1" });
    expect(String(paid.body.explorerUrl)).toMatch(/^https:\/\/arbiscan\.io\/tx\/0x/);
  });

  it("reports expired and blocked", async () => {
    const a = await call(client, "request_payment", { amount: "0.10", purpose: "a" });
    const b = await call(client, "request_payment", { amount: "0.10", purpose: "b" });
    chain.consumed.add(decodeRequest(String(b.body.url)).quote.purchaseRef);
    expect((await call(client, "check_payment", { request_id: b.body.requestId })).body.status).toBe("blocked");
    chain.mine(1n, 4_000n);
    expect((await call(client, "check_payment", { request_id: a.body.requestId })).body.status).toBe("expired");
  });

  it("rejects bad input", async () => {
    expect((await call(client, "request_payment", { amount: "0.00001", purpose: "x" })).isError).toBe(true);
    expect((await call(client, "request_payment", { amount: "abc", purpose: "x" })).isError).toBe(true);
    expect((await call(client, "check_payment", { request_id: "req_nope" })).isError).toBe(true);
  });

  it("the paid action refuses until paid, checks purpose and price, and runs once per receipt", async () => {
    const wrongPurpose = await call(client, "request_payment", { amount: "0.10", purpose: "something else" });
    await pay(String(wrongPurpose.body.url));
    const r1 = await call(client, "premium_fortune", { request_id: wrongPurpose.body.requestId, topic: "deploys" });
    expect(r1.isError).toBe(true);
    expect(r1.raw).toMatch(/was for "something else"/);

    const cheap = await call(client, "request_payment", { amount: "0.01", purpose: DEMO_PURPOSE });
    await pay(String(cheap.body.url));
    const r2 = await call(client, "premium_fortune", { request_id: cheap.body.requestId, topic: "deploys" });
    expect(r2.isError).toBe(true);
    expect(r2.raw).toMatch(/costs 0.1 USDC/);

    const good = await call(client, "request_payment", { amount: "0.10", purpose: DEMO_PURPOSE });
    const unpaid = await call(client, "premium_fortune", { request_id: good.body.requestId, topic: "deploys" });
    expect(unpaid.isError).toBe(true);
    expect(unpaid.raw).toMatch(/"pending", not "paid"/);

    await pay(String(good.body.url));
    const ran = await call(client, "premium_fortune", { request_id: good.body.requestId, topic: "deploys" });
    expect(ran.isError, ran.raw).toBe(false);
    expect(String(ran.body.fortune)).toContain("deploys");
    const again = await call(client, "premium_fortune", { request_id: good.body.requestId, topic: "deploys" });
    expect(again.isError).toBe(true);
    expect(again.raw).toMatch(/already been used/);
  });

  it("the paid action refuses a blocked request", async () => {
    const r = await call(client, "request_payment", { amount: "0.10", purpose: DEMO_PURPOSE });
    chain.consumed.add(decodeRequest(String(r.body.url)).quote.purchaseRef);
    const result = await call(client, "premium_fortune", { request_id: r.body.requestId, topic: "x" });
    expect(result.isError).toBe(true);
    expect(result.raw).toMatch(/"blocked"/);
  });
});

const forkUrl = process.env.ARBITRUM_RPC_URL;

describe.skipIf(!forkUrl)("MCP server over stdio against an Arbitrum One fork", { timeout: 120_000 }, () => {
  const sellerKey = generatePrivateKey();
  const seller = privateKeyToAccount(sellerKey);
  const payer = getAddress("0x00000000000000000000000000000000fa1d00bb");
  let fork: AnvilFork;
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = "";

  beforeAll(async () => {
    fork = await startFork(forkUrl!, arbitrum);
    await fork.testClient.setBalance({ address: seller.address, value: 10n ** 18n });
    await fork.testClient.setBalance({ address: payer, value: 10n ** 18n });
    await fork.testClient.impersonateAccount({ address: payer });
    await dealErc20(fork, NOTA_DEPLOYMENTS[42161].usdc, payer, 1_000_000n);
    const sellerWallet = createWalletClient({ chain: arbitrum, account: seller, transport: http(fork.rpcUrl, { timeout: 120_000 }) });
    const { listingId } = await setup({ walletClient: sellerWallet, publicClient: fork.publicClient, listing: { title: "MCP test" } });

    const root = resolve(import.meta.dirname, "..");
    transport = new StdioClientTransport({
      command: resolve(root, "node_modules/.bin/tsx"),
      args: [resolve(root, "examples/mcp-server.ts")],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", SIGNER_PRIVATE_KEY: sellerKey, LISTING_ID: listingId.toString(), RPC_URL: fork.rpcUrl, PAY_BASE_URL: "http://localhost:3000/pay" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await fork?.stop();
  });

  it("request -> pay -> paid -> paid action runs once; the key never appears in output", async () => {
    const created = await call(client, "request_payment", { amount: "0.10", purpose: DEMO_PURPOSE });
    expect(created.isError).toBe(false);
    expect((await call(client, "check_payment", { request_id: created.body.requestId })).body.status).toBe("pending");

    const payerWallet = createWalletClient({ chain: arbitrum, account: payer, transport: http(fork.rpcUrl, { timeout: 120_000 }) });
    const { receipt } = await payRequest({ walletClient: payerWallet, publicClient: fork.publicClient, request: String(created.body.url) });

    const paid = await call(client, "check_payment", { request_id: created.body.requestId });
    expect(paid.body.status).toBe("paid");
    expect(paid.body.receipt).toMatchObject({ payer, receiptId: receipt.receiptId.toString(), txHash: receipt.txHash });
    expect(paid.body.explorerUrl).toBe(`https://arbiscan.io/tx/${receipt.txHash}`);

    expect((await call(client, "premium_fortune", { request_id: created.body.requestId, topic: "gas" })).isError).toBe(false);
    expect((await call(client, "premium_fortune", { request_id: created.body.requestId, topic: "gas" })).isError).toBe(true);

    expect(stderr).toContain(`signer ${seller.address}`);
    expect(stderr.toLowerCase()).not.toContain(sellerKey.slice(2).toLowerCase());
    expect(JSON.stringify([created, paid]).toLowerCase()).not.toContain(sellerKey.slice(2).toLowerCase());
  });
});

