/**
 * A local stdio MCP server that lets an AI client ask its user for USDC and gate a paid action on
 * a verified on-chain receipt. Requests are kept in memory; nothing is hosted.
 *
 * Environment:
 *   SIGNER_PRIVATE_KEY  key that signs requests: the listing's seller or a signer it authorized.
 *                       Never printed or logged.
 *   LISTING_ID          the seller's listing (see `setup` / examples/agent.ts --setup)
 *   RPC_URL             the chain is taken from this endpoint's chain id
 *   PAY_BASE_URL        optional; payment page the links point at (default https://usenota.xyz/pay)
 *   DEMO_PRICE_USDC     optional; minimum paid for the demo action (default 0.10)
 *
 * Tools:
 *   request_payment(amount, purpose)  -> link, expiry and a request id
 *   check_payment(request_id)         -> paid (with receipt and explorer link) | pending | expired | blocked
 *   premium_fortune(request_id, topic) -> the demo paid action; runs once per receipt, only for a
 *                                       paid request whose purpose is "premium fortune"
 *
 * Desktop client config (e.g. claude_desktop_config.json), with absolute paths:
 *   {
 *     "mcpServers": {
 *       "nota-payments": {
 *         "command": "/ABSOLUTE/PATH/sdk/node_modules/.bin/tsx",
 *         "args": ["/ABSOLUTE/PATH/sdk/examples/mcp-server.ts"],
 *         "env": {
 *           "SIGNER_PRIVATE_KEY": "0x...",
 *           "LISTING_ID": "1",
 *           "RPC_URL": "https://...",
 *           "PAY_BASE_URL": "https://usenota.xyz/pay"
 *         }
 *       }
 *     }
 *   }
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient, http, toHex, type Hex, type LocalAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import {
  DEFAULT_BASE_URL,
  NotaError,
  assertDeployment,
  createRequest,
  formatUsdc,
  getDeployment,
  notaReceiptStoreAbi,
  parseUsdc,
  readRequest,
  type CreateRequestResult,
  type NotaDeployment,
} from "../src/index.js";

export const DEMO_PURPOSE = "premium fortune";

export interface PaymentServerConfig {
  publicClient: PublicClient;
  /** Signs requests. Its key stays inside this process. */
  account: LocalAccount;
  listingId: bigint;
  deployment: NotaDeployment;
  baseUrl?: string;
  /** Minimum amount, in USDC base units, a receipt must show for the demo action. */
  demoPrice?: bigint;
}

interface StoredRequest {
  id: string;
  purpose: string;
  created: CreateRequestResult;
}

type CheckResult =
  | { status: "paid"; receipt: Record<string, string>; explorerUrl: string; receiptKey: string; amount: bigint }
  | { status: "pending" | "expired" | "blocked" | "invalid"; reason?: string };

function text(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function newRequestId(): string {
  return `req_${toHex(globalThis.crypto.getRandomValues(new Uint8Array(8))).slice(2)}`;
}

export function createPaymentServer(config: PaymentServerConfig): McpServer {
  const { publicClient, account, listingId, deployment } = config;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const demoPrice = config.demoPrice ?? 100_000n;
  const requests = new Map<string, StoredRequest>();
  const usedReceipts = new Set<string>();

  const server = new McpServer({ name: "nota-payments", version: "0.1.0" });

  async function check(stored: StoredRequest): Promise<CheckResult> {
    const { status, receipt, reason } = await readRequest(stored.created, { publicClient });
    switch (status) {
      case "paid":
        return {
          status: "paid",
          receipt: {
            receiptId: receipt!.receiptId.toString(),
            payer: receipt!.payer,
            seller: receipt!.seller,
            amountUsdc: formatUsdc(receipt!.amount),
            txHash: receipt!.txHash,
            blockNumber: receipt!.blockNumber.toString(),
          },
          explorerUrl: `${deployment.explorer}/tx/${receipt!.txHash}`,
          receiptKey: `${receipt!.chainId}:${receipt!.receiptId}`,
          amount: receipt!.amount,
        };
      case "payable":
        return { status: "pending" };
      case "expired":
        return { status: "expired" };
      case "blocked":
        return { status: "blocked", reason: "The payment reference was consumed without a matching payment. Not paid; create a new request." };
      default:
        // listing_inactive, invalid_signature (e.g. the signer was revoked), and so on.
        return { status: "invalid", reason: `${status}: ${reason ?? ""}`.trim() };
    }
  }

  function lookup(id: string): StoredRequest | undefined {
    return requests.get(id);
  }

  server.registerTool(
    "request_payment",
    {
      title: "Request a USDC payment",
      description:
        `Create a signed payment link for a USDC amount on ${deployment.name}. Show the link to the user; anyone can pay it. ` +
        "Returns a request id to pass to check_payment.",
      inputSchema: {
        amount: z.string().describe('USDC amount as a decimal string, e.g. "0.10"'),
        purpose: z.string().min(1).max(500).describe("What the payment is for. Stored in the signed request; no secrets or personal data."),
      },
    },
    async ({ amount, purpose }) => {
      try {
        const created = await createRequest({ account, publicClient, listingId, amount: parseUsdc(amount), purpose, baseUrl });
        const id = newRequestId();
        requests.set(id, { id, purpose, created });
        return text({
          requestId: id,
          url: created.url,
          amountUsdc: formatUsdc(created.quote.amount),
          purpose,
          chain: deployment.name,
          expiresAt: new Date(Number(created.quote.expiresAt) * 1000).toISOString(),
        });
      } catch (error) {
        return text(`Could not create the request: ${(error as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "check_payment",
    {
      title: "Check a payment request",
      description: 'Status of a request from request_payment: "paid" (with the on-chain receipt), "pending", "expired" or "blocked".',
      inputSchema: { request_id: z.string().describe("The requestId returned by request_payment") },
    },
    async ({ request_id }) => {
      const stored = lookup(request_id);
      if (!stored) return text(`Unknown request id ${request_id}. Requests are kept in memory and are lost on restart.`, true);
      try {
        const result = await check(stored);
        if (result.status === "paid") {
          return text({ status: "paid", requestId: request_id, purpose: stored.purpose, receipt: result.receipt, explorerUrl: result.explorerUrl });
        }
        return text({ status: result.status, requestId: request_id, ...(result.reason ? { reason: result.reason } : {}) });
      } catch (error) {
        return text(`Could not check the request: ${(error as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "premium_fortune",
    {
      title: "Premium fortune (paid demo)",
      description:
        `A paid demo action costing at least ${formatUsdc(demoPrice)} USDC. First call request_payment with purpose exactly ` +
        `"${DEMO_PURPOSE}", have the user pay the link, then call this with the request id. Each payment buys one fortune.`,
      inputSchema: {
        request_id: z.string().describe(`A paid request whose purpose is "${DEMO_PURPOSE}"`),
        topic: z.string().min(1).max(100).describe("What the fortune should be about"),
      },
    },
    async ({ request_id, topic }) => {
      const stored = lookup(request_id);
      if (!stored) return text(`Refused: unknown request id ${request_id}.`, true);
      if (stored.purpose.trim().toLowerCase() !== DEMO_PURPOSE) {
        return text(`Refused: request ${request_id} was for "${stored.purpose}", not "${DEMO_PURPOSE}". Create a request with that purpose.`, true);
      }
      let result: CheckResult;
      try {
        // Always re-check on-chain; never trust an earlier answer.
        result = await check(stored);
      } catch (error) {
        return text(`Refused: could not verify payment: ${(error as Error).message}`, true);
      }
      if (result.status !== "paid") {
        return text(`Refused: request ${request_id} is "${result.status}", not "paid".${result.reason ? ` ${result.reason}` : ""}`, true);
      }
      if (result.amount < demoPrice) {
        return text(`Refused: receipt shows ${formatUsdc(result.amount)} USDC; this action costs ${formatUsdc(demoPrice)} USDC.`, true);
      }
      if (usedReceipts.has(result.receiptKey)) {
        return text(`Refused: receipt ${result.receipt.receiptId} has already been used. Each payment buys one fortune.`, true);
      }
      usedReceipts.add(result.receiptKey);
      return text({
        fortune: fortuneFor(topic, result.receipt.receiptId!),
        paidWithReceipt: result.receipt.receiptId,
        explorerUrl: result.explorerUrl,
      });
    },
  );

  return server;
}

const OPENINGS = ["The ledger favours", "A quiet block confirms", "Fortune settles on", "The chain remembers"];
const CLOSINGS = ["before the next epoch.", "within one confirmation.", "when you least expect a revert.", "at exactly the quoted price."];

function fortuneFor(topic: string, receiptId: string): string {
  let seed = 0;
  for (const char of `${topic}:${receiptId}`) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return `${OPENINGS[seed % OPENINGS.length]} your ${topic} ${CLOSINGS[(seed >>> 3) % CLOSINGS.length]}`;
}

async function main(): Promise<void> {
  const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
  };
  const privateKey = process.env.SIGNER_PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  const listingIdRaw = process.env.LISTING_ID;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail("SIGNER_PRIVATE_KEY must be set to a 0x-prefixed 32-byte hex key.");
  if (!rpcUrl) fail("RPC_URL must be set.");
  if (!listingIdRaw || !/^[1-9][0-9]*$/.test(listingIdRaw)) fail("LISTING_ID must be set to a listing id.");
  const baseUrl = process.env.PAY_BASE_URL || DEFAULT_BASE_URL;
  if (!/^https?:\/\/[^#]+$/.test(baseUrl)) fail("PAY_BASE_URL must be an http(s) URL without a fragment.");

  const publicClient = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  const chainId = await publicClient.getChainId();
  const deployment = getDeployment(chainId) ?? fail(`RPC_URL is on chain ${chainId}, which Nota does not support.`);
  await assertDeployment(publicClient);

  const account = privateKeyToAccount(privateKey as Hex);
  const listingId = BigInt(listingIdRaw!);
  const canSign = await publicClient
    .readContract({ address: deployment.store, abi: notaReceiptStoreAbi, functionName: "isQuoteSignerAuthorized", args: [listingId, account.address] })
    .catch((error: unknown) => fail(`Listing ${listingId} could not be read: ${(error as Error).message}`));
  if (!canSign) fail(`${account.address} is not the seller of listing ${listingId} or an authorized signer for it.`);

  const demoPrice = process.env.DEMO_PRICE_USDC ? parseUsdc(process.env.DEMO_PRICE_USDC) : undefined;
  const server = createPaymentServer({ publicClient, account, listingId, deployment, baseUrl, ...(demoPrice !== undefined ? { demoPrice } : {}) });
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; diagnostics go to stderr. The key is never printed.
  console.error(`nota-payments MCP server: ${deployment.name} (${chainId})${deployment.testnet ? " [testnet]" : ""}, signer ${account.address}, listing ${listingId}`);
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof NotaError ? `${error.code}: ${error.message}` : error);
    process.exit(1);
  });
}
