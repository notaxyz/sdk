import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ListingError, describeListing, resolveListingId, verifyListing } from "../examples/listing.js";
import { decodeRequest } from "../src/index.js";
import { FakeChain } from "./helpers/fake-chain.js";

describe("resolveListingId", () => {
  it("prefers the flag, then the env var, then the saved file", () => {
    expect(resolveListingId({ flag: "3", env: "4", saved: 5n })).toEqual({ listingId: 3n, source: "--listing-id flag", explicit: true });
    expect(resolveListingId({ env: "4", saved: 5n })).toEqual({ listingId: 4n, source: "LISTING_ID env", explicit: true });
    expect(resolveListingId({ flag: "", env: "4", saved: 5n })?.source).toBe("LISTING_ID env");
    expect(resolveListingId({ env: "", saved: 5n })).toEqual({ listingId: 5n, source: "saved file", explicit: false });
    expect(resolveListingId({})).toBeUndefined();
    expect(resolveListingId({ env: "" })).toBeUndefined();
  });

  it("rejects ids that are not positive integers", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "0x10"]) {
      expect(() => resolveListingId({ flag: bad })).toThrow(ListingError);
      expect(() => resolveListingId({ env: bad })).toThrow(/LISTING_ID env/);
    }
  });

  it("refuses --setup together with an explicit id", () => {
    expect(() => resolveListingId({ flag: "3", setup: true })).toThrow(/Refusing --setup.*listing 3.*--listing-id flag/);
    expect(() => resolveListingId({ env: "4", setup: true })).toThrow(/Refusing --setup.*listing 4.*LISTING_ID env/);
    // --setup is allowed with no id, and does nothing new when an id was saved by an earlier setup.
    expect(resolveListingId({ setup: true })).toBeUndefined();
    expect(resolveListingId({ saved: 5n, setup: true })?.listingId).toBe(5n);
  });
});

describe("verifyListing", () => {
  const seller = privateKeyToAccount(generatePrivateKey());
  const signer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  let chain: FakeChain;
  let listingId: bigint;
  beforeEach(() => {
    chain = new FakeChain();
    listingId = chain.addListing(seller.address);
  });
  const verify = (id: bigint, wallet: `0x${string}`) => verifyListing({ publicClient: chain.client, deployment: chain.deployment, listingId: id, wallet });

  it("refuses a missing listing", async () => {
    await expect(verify(99n, seller.address)).rejects.toThrow(/Listing 99 does not exist on Arbitrum One/);
  });

  it("refuses an inactive listing", async () => {
    chain.listings.get(listingId)!.active = false;
    await expect(verify(listingId, seller.address)).rejects.toThrow(/is inactive/);
  });

  it("refuses a wallet that is neither seller nor authorized signer", async () => {
    await expect(verify(listingId, stranger.address)).rejects.toThrow(
      new RegExp(`${stranger.address} is neither the seller of listing ${listingId} \\(${seller.address}\\) nor an authorized quote signer`),
    );
    chain.authorizeSigner(listingId, signer.address);
    chain.authorizeSigner(listingId, signer.address, false);
    await expect(verify(listingId, signer.address)).rejects.toThrow(ListingError); // revoked
  });

  it("accepts the seller and an authorized signer, naming the seller for the signer", async () => {
    expect(await verify(listingId, seller.address)).toEqual({ seller: seller.address, role: "seller" });
    chain.authorizeSigner(listingId, signer.address);
    const asSigner = await verify(listingId, signer.address);
    expect(asSigner).toEqual({ seller: seller.address, role: "signer" });
    const line = describeListing({ listingId, source: "LISTING_ID env", explicit: true }, asSigner);
    expect(line).toBe(`Using listing ${listingId} (from LISTING_ID env); this wallet is an authorized signer, payments go to the seller ${seller.address}.`);
  });
});

/**
 * Runs the real examples/agent.ts against the fake chain served over local HTTP JSON-RPC, so the
 * printed output, exit codes and state-file handling are tested end to end without a network.
 */
describe("examples/agent.ts against the fake chain", { timeout: 60_000 }, () => {
  const root = resolve(import.meta.dirname, "..");
  const sellerKey = generatePrivateKey();
  const seller = privateKeyToAccount(sellerKey);
  const signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey);
  const strangerKey = generatePrivateKey();
  let chain: FakeChain;
  let server: Server;
  let rpcUrl: string;
  let dir: string;
  let stateFile: string;
  let listingId: bigint;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const { id, method, params } = JSON.parse(body);
        let reply: Record<string, unknown>;
        try {
          reply = { jsonrpc: "2.0", id, result: await chain.request({ method, params }) };
        } catch (error) {
          const e = error as { code?: number; message: string; data?: string };
          reply = { jsonrpc: "2.0", id, error: { code: e.code ?? -32000, message: e.message, data: e.data } };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    rpcUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  beforeEach(() => {
    chain = new FakeChain();
    listingId = chain.addListing(seller.address);
    dir = mkdtempSync(join(tmpdir(), "nota-agent-"));
    stateFile = join(dir, "state.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Run the agent; when it prints a link, pay it on the fake chain so the run completes. */
  function runAgent(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
    return new Promise((done) => {
      const child = spawn(resolve(root, "node_modules/.bin/tsx"), [resolve(root, "examples/agent.ts"), ...args], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", RPC_URL: rpcUrl, NOTA_AGENT_STATE_FILE: stateFile, ...env },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        const link = /Pay here: (\S+)/.exec(out)?.[1];
        if (link && !out.includes("__paid__")) {
          out += "__paid__";
          const r = decodeRequest(link);
          chain.emitReceipt({
            seller: r.seller,
            buyer: "0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8",
            listingId: r.quote.listingId,
            purchaseRef: r.quote.purchaseRef,
            amount: r.quote.amount,
            metadataHash: r.quote.metadataHash,
            agentId: r.quote.agentId,
          });
        }
      });
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      child.on("exit", (code) => done({ code: code ?? -1, out, err }));
    });
  }

  it("uses --listing-id over LISTING_ID and the saved file, and never writes the state file", async () => {
    const other = chain.addListing(seller.address);
    writeFileSync(stateFile, JSON.stringify({ [`42161:${seller.address.toLowerCase()}`]: "99" }));
    const before = readFileSync(stateFile, "utf8");
    const run = await runAgent(["--listing-id", String(listingId)], { AGENT_PRIVATE_KEY: sellerKey, LISTING_ID: String(other) });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Using listing ${listingId} (from --listing-id flag); this wallet is its seller.`);
    expect(run.out).toContain("Funded. Continuing.");
    expect(readFileSync(stateFile, "utf8")).toBe(before);
  });

  it("uses LISTING_ID when no flag is given, and does not create a state file", async () => {
    const run = await runAgent([], { AGENT_PRIVATE_KEY: sellerKey, LISTING_ID: String(listingId) });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Using listing ${listingId} (from LISTING_ID env); this wallet is its seller.`);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("falls back to the saved file", async () => {
    writeFileSync(stateFile, JSON.stringify({ [`42161:${seller.address.toLowerCase()}`]: String(listingId) }));
    const run = await runAgent([], { AGENT_PRIVATE_KEY: sellerKey });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Using listing ${listingId} (from saved file); this wallet is its seller.`);
  });

  it("names the seller when the wallet is an authorized signer", async () => {
    chain.authorizeSigner(listingId, signer.address);
    const run = await runAgent(["--listing-id", String(listingId)], { AGENT_PRIVATE_KEY: signerKey });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`this wallet is an authorized signer, payments go to the seller ${seller.address}.`);
    expect(run.out).toContain("Funded. Continuing.");
  });

  it("with no id at all, prints the setup transaction and exits without sending", async () => {
    const run = await runAgent([], { AGENT_PRIVATE_KEY: sellerKey });
    expect(run.code).toBe(1);
    expect(run.out).toContain("One-time setup transaction (NOT sent)");
    expect(run.out).toContain("--listing-id <id>");
    expect(chain.sentTransactions.size).toBe(0);
    expect(existsSync(stateFile)).toBe(false);
  });

  it.each([
    ["a missing listing", () => ["--listing-id", "99"], () => sellerKey, /Listing 99 does not exist/],
    ["an inactive listing", () => ["--listing-id", String(listingId)], () => (chain.listings.get(listingId)!.active = false, sellerKey), /is inactive/],
    ["a wallet that is neither seller nor signer", () => ["--listing-id", String(listingId)], () => strangerKey, /is neither the seller of listing/],
    ["--setup with an explicit id", () => ["--listing-id", String(listingId), "--setup"], () => sellerKey, /Refusing --setup/],
  ])("refuses %s, sends nothing, writes nothing", async (_name, args, key, message) => {
    const run = await runAgent(args(), { AGENT_PRIVATE_KEY: key() });
    expect(run.code).toBe(1);
    expect(run.err).toMatch(message);
    expect(run.out).not.toContain("Pay here");
    expect(chain.sentTransactions.size).toBe(0);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("refuses --setup with LISTING_ID too", async () => {
    const run = await runAgent(["--setup"], { AGENT_PRIVATE_KEY: sellerKey, LISTING_ID: String(listingId) });
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/Refusing --setup.*LISTING_ID env/);
    expect(chain.sentTransactions.size).toBe(0);
  });

  it("never prints the private key", async () => {
    const run = await runAgent(["--listing-id", String(listingId)], { AGENT_PRIVATE_KEY: sellerKey });
    expect((run.out + run.err).toLowerCase()).not.toContain(sellerKey.slice(2).toLowerCase());
  });
});
