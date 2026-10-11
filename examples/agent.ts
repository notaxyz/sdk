/**
 * An agent that runs out of budget, asks for funding with a Nota payment link, and continues once
 * a verified on-chain receipt arrives.
 *
 *   export AGENT_PRIVATE_KEY=0x...   # issuing hot wallet: needs a little ETH for the one-time setup
 *   export RPC_URL=https://...       # or ARBITRUM_RPC_URL; the chain is taken from the RPC's chain id
 *   npx tsx examples/agent.ts                      # first run: prints the setup transaction, exits
 *   npx tsx examples/agent.ts --setup              # sends the one-time createListing transaction
 *   npx tsx examples/agent.ts --amount 0.10 --purpose "run 100 more searches"
 *   npx tsx examples/agent.ts --base-url http://localhost:3000/pay   # links for a local payment page
 *
 * Supported chains: Arbitrum One, Base, and the Arbitrum Sepolia testnet.
 * The private key is read from the environment and never printed or logged.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createPublicClient, createWalletClient, http, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia, base } from "viem/chains";

import {
  createRequest,
  formatUsdc,
  isNotaError,
  getDeployment,
  parseUsdc,
  prepareSetup,
  setup,
  waitForReceipt,
} from "../src/index.js";

const STATE_FILE = new URL("../.nota-agent.json", import.meta.url);
const LISTING = {
  schema: "nota.listing.metadata.v1",
  kind: "agent_request",
  title: "Agent budget top-up",
  currency: "USDC",
  decimals: 6,
};

/** 100000n -> "0.10": at least two decimals, like a price. */
function usdc(amount: bigint): string {
  const [whole, fraction = ""] = formatUsdc(amount).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const { values: flags } = parseArgs({
  options: {
    amount: { type: "string", default: "0.10" },
    purpose: { type: "string", default: "continue the current task" },
    expires: { type: "string", default: "3600" },
    setup: { type: "boolean", default: false },
    "base-url": { type: "string" },
  },
});

const CHAINS: Record<number, Chain> = { [arbitrum.id]: arbitrum, [base.id]: base, [arbitrumSepolia.id]: arbitrumSepolia };

const privateKey = process.env.AGENT_PRIVATE_KEY;
const rpcUrl = process.env.RPC_URL || process.env.ARBITRUM_RPC_URL;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail("AGENT_PRIVATE_KEY must be set to a 0x-prefixed 32-byte hex key.");
if (!rpcUrl) fail("RPC_URL (or ARBITRUM_RPC_URL) must be set.");
const baseUrl = flags["base-url"];
if (baseUrl !== undefined && !/^https?:\/\/[^#]+$/.test(baseUrl)) fail("--base-url must be an http(s) URL without a fragment.");

// The chain comes from the RPC endpoint itself, not from an assumption.
const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
const chain = CHAINS[chainId];
const deployment = getDeployment(chainId);
if (!chain || !deployment) fail(`The RPC is on chain ${chainId}, which Nota does not support (Arbitrum One, Base, Arbitrum Sepolia).`);

const account = privateKeyToAccount(privateKey as Hex);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
console.log(`Chain: ${deployment.name} (${chainId})${deployment.testnet ? " [testnet]" : ""}`);
const stateKey = `${deployment.chainId}:${account.address.toLowerCase()}`;

function loadListingId(): bigint | undefined {
  if (!existsSync(STATE_FILE)) return undefined;
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, string>;
  return state[stateKey] !== undefined ? BigInt(state[stateKey]) : undefined;
}

function saveListingId(listingId: bigint): void {
  const state = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, string>) : {};
  state[stateKey] = listingId.toString();
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

let amount: bigint;
try {
  amount = parseUsdc(flags.amount);
} catch (error) {
  fail((error as Error).message);
}
const expiresInSeconds = Number(flags.expires);

let listingId = loadListingId();
if (listingId === undefined) {
  const prepared = await prepareSetup({ publicClient, listing: LISTING });
  if (!flags.setup) {
    console.log("No listing saved for this wallet yet. One-time setup transaction (NOT sent):");
    console.log(`  chain:       ${deployment.name} (${prepared.chainId})`);
    console.log(`  from:        ${account.address}`);
    console.log(`  to:          ${prepared.to}  (NotaReceiptStore)`);
    console.log(`  value:       0`);
    console.log(`  call:        createListing(${prepared.listingHash}, 0, SignedQuoteOnly)`);
    console.log(`  data:        ${prepared.data}`);
    console.log(`  listing doc: ${prepared.canonicalListing}`);
    console.log("Run again with --setup to send it. The sending wallet becomes the seller and receives every payment.");
    process.exit(1);
  }
  console.log(`Sending createListing from ${account.address} ...`);
  const result = await setup({ walletClient, publicClient, listing: LISTING });
  saveListingId(result.listingId);
  console.log(`Listing ${result.listingId} created: ${deployment.explorer}/tx/${result.txHash}`);
  listingId = result.listingId;
}

console.log(`Budget exhausted: need ${usdc(amount)} USDC to ${flags.purpose}`);

const request = await createRequest({
  account,
  publicClient,
  listingId,
  amount,
  purpose: flags.purpose,
  expiresInSeconds,
  ...(baseUrl !== undefined ? { baseUrl } : {}),
});
console.log(`Pay here: ${request.url}`);
console.log(`Waiting for payment (expires ${new Date(Number(request.quote.expiresAt) * 1000).toISOString()}) ...`);

try {
  const receipt = await waitForReceipt({ publicClient, request });
  console.log(`Payer:      ${receipt.payer}`);
  console.log(`Amount:     ${usdc(receipt.amount)} USDC`);
  console.log(`Receipt id: ${receipt.receiptId}`);
  console.log(`Explorer:   ${deployment.explorer}/tx/${receipt.txHash}`);
  console.log("Funded. Continuing.");
} catch (error) {
  if (isNotaError(error, "purchase_ref_blocked")) {
    fail("Request blocked: its reference was consumed without a matching payment. Not funded. Issue a new request.", 2);
  }
  if (isNotaError(error, "timeout")) fail("Request expired unpaid. Not funded.", 3);
  throw error;
}
