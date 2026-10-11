import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import {
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  http,
  keccak256,
  numberToHex,
  type Address,
  type Chain,
  type PublicClient,
  type TestClient,
} from "viem";

import { erc20Abi } from "../../src/abi.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface AnvilFork {
  rpcUrl: string;
  publicClient: PublicClient;
  testClient: TestClient;
  stop: () => Promise<void>;
}

/** Start `anvil --fork-url` on a free local port. Nothing is ever sent to the forked network. */
export async function startFork(forkUrl: string, chain: Chain): Promise<AnvilFork> {
  const port = await freePort();
  const child: ChildProcess = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent", "--no-rate-limit", "--retries", "10", "--fork-retry-backoff", "1000", "--timeout", "60000"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl, { retryCount: 3, timeout: 120_000 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 100 }) as PublicClient;
  const testClient = createTestClient({ chain, mode: "anvil", transport });

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${stderr.trim()}`);
    try {
      await publicClient.getBlockNumber();
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`anvil did not start: ${stderr.trim()}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return {
    rpcUrl,
    publicClient,
    testClient,
    stop: async () => {
      child.kill();
      await exited;
    },
  };
}

/** Give `holder` exactly `amount` of an ERC-20 by locating its balance mapping slot. */
export async function dealErc20(fork: AnvilFork, token: Address, holder: Address, amount: bigint): Promise<void> {
  // FiatToken (USDC) keeps balances at slot 9; try it first, then scan.
  const slots = [9n, ...Array.from({ length: 64 }, (_, i) => BigInt(i)).filter((s) => s !== 9n)];
  for (const slot of slots) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));
    const previous = await fork.publicClient.getStorageAt({ address: token, slot: key });
    await fork.testClient.setStorageAt({ address: token, index: key, value: numberToHex(amount, { size: 32 }) });
    const balance = await fork.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    if (balance === amount) return;
    await fork.testClient.setStorageAt({ address: token, index: key, value: previous ?? numberToHex(0, { size: 32 }) });
  }
  throw new Error(`could not find the balance slot of ${token}`);
}
