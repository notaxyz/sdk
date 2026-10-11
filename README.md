# @notaxyz/sdk

`@notaxyz/sdk` lets an agent, or any seller, turn a USDC amount and a purpose into a signed payment link. Anyone with the link can pay it in USDC on Arbitrum One or Base, or with test USDC on the Arbitrum Sepolia testnet. Payment goes through the deployed Nota receipt contract, which sends the funds straight to the issuer and emits an on-chain receipt that the issuer can wait for and verify. There is no backend, database or hosted service: everything happens client-side, plus reads and writes against the chain.

## Install

```bash
npm install @notaxyz/sdk viem
```

`viem` (v2) is a peer dependency. The package is ESM-only and runs in browsers and Node.js 20 or later. It uses the global Web Crypto API, which Node.js has unflagged only from v19. It's tested on Node 20.17 and 22.22. Node 18 isn't supported.

## For an agent: two calls

One-time setup creates the issuer's listing. The issuing wallet becomes the seller and receives every payment, and setup costs one transaction of gas:

```ts
import { setup } from "@notaxyz/sdk";

const { listingId } = await setup({
  walletClient,
  publicClient,
  listing: { schema: "nota.listing.metadata.v1", kind: "agent_request", title: "Agent budget top-up", currency: "USDC", decimals: 6 },
});
// Store listingId; reuse it for every request.
```

After that, each top-up takes two calls and no transactions from the issuer:

```ts
import { createRequest, waitForReceipt, parseUsdc } from "@notaxyz/sdk";

const request = await createRequest({
  account,                       // or walletClient
  publicClient,
  listingId,
  amount: parseUsdc("0.10"),     // USDC base units: 100000n
  purpose: "run 100 more searches",
});
console.log(`Budget exhausted. Pay here: ${request.url}`);

const receipt = await waitForReceipt({ publicClient, request });
console.log(`Funded by ${receipt.payer}, receipt #${receipt.receiptId}, tx ${receipt.txHash}`);
```

`waitForReceipt` resolves only on a verified matching receipt. It rejects with `NotaError` code `"purchase_ref_blocked"` if the request's reference was consumed without one (see [Known limitation](#known-limitation-blocked-requests)), and with `"timeout"` if nobody pays before expiry. `getReceipt` does the same check once and returns `null` while the request is unpaid.

[`examples/agent.ts`](examples/agent.ts) is a complete runnable agent:

```bash
AGENT_PRIVATE_KEY=0x... RPC_URL=https://... npx tsx examples/agent.ts --amount 0.10 --purpose "run 100 more searches"
```

The example works like this:
- **Chain:** it takes the chain from the RPC's chain id (Arbitrum One, Base or the Arbitrum Sepolia testnet).
- **RPC variable:** it reads `RPC_URL`, or `ARBITRUM_RPC_URL` if `RPC_URL` isn't set.
- **Setup:** on the first run it prints the setup transaction it would send and exits. Run it with `--setup` to send that transaction.
- **Local testing:** `--base-url http://localhost:3000/pay` makes the links point at a local payment page.

## For a payer

```ts
import { readRequest, payRequest } from "@notaxyz/sdk";

const { status, request, reason } = await readRequest(url, { publicClient });
if (status === "payable") {
  console.log(request.metadata.checkout.description, request.quote.amount);
  const { approveTxHash, payTxHash, receipt } = await payRequest({ walletClient, publicClient, request: url });
}
```

`payRequest` runs `readRequest` first and refuses anything that isn't `"payable"`. It also checks the payer's USDC balance. When the payer's existing allowance is too low, it approves the store for **exactly** the quoted amount, never an unlimited amount. It then calls `purchaseSignedReceipt`, which moves the USDC from the payer through the store to the seller in the same transaction. It returns the verified receipt from that transaction's `ReceiptPurchasedV2` log.

### Smart accounts: one batched operation

`preparePayCalls` performs the same checks as `payRequest` and returns the calls without sending anything:
- it refuses anything that isn't `"payable"`
- it checks the payer's balance
- it adds an exact-amount approval only when the allowance is short

A smart account can batch the returned calls into one operation:

```ts
import { preparePayCalls } from "@notaxyz/sdk";

const { calls, needsApproval } = await preparePayCalls({ publicClient, request: url, payer: smartAccount.address });
// calls: [{ to: USDC, data: approve(store, amount) }?, { to: store, data: purchaseSignedReceipt(...) }], all with value 0
await walletClient.sendCalls({ account: smartAccount, calls }); // EIP-5792, e.g. viem
```

`payRequest` uses `preparePayCalls` internally and sends the calls one at a time.

## Link format

```
https://usenota.xyz/pay#r=<base64url(JSON)>
```

The payload sits in the URL fragment, which browsers never send to a server. The JSON is:

```json
{
  "v": 1,
  "chainId": 42161,
  "store": "0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88",
  "quote": {
    "listingId": "1", "buyer": "0x0000000000000000000000000000000000000000",
    "purchaseRef": "0x…", "amount": "100000", "metadataHash": "0x…", "agentId": "0x…",
    "integratorFeeRecipient": "0x0000000000000000000000000000000000000000", "integratorFeeAmount": "0",
    "issuedAt": "1791643436", "expiresAt": "1791647036"
  },
  "signature": "0x…",
  "metadata": { "schema": "nota.checkout.metadata.v1", "…": "…" },
  "fromBlock": "513536720"
}
```

The format follows these rules:

- **Numbers:** bigint values are decimal strings, and unknown versions and unknown fields are rejected.
- **Quote:** `quote` is the contract's `SignedReceiptQuote`. It is unbound (`buyer` = zero address, so anyone may pay) and carries no integrator fee. It's signed with EIP-712 by the seller over the contract's `SIGNED_RECEIPT_QUOTE_TYPEHASH`, under the domain `NotaReceiptStore` / `2`.
- **Metadata:** `metadata` is the [`nota.checkout.metadata.v1`](https://github.com/notaxyz/contracts#canonical-checkout-metadata) document. The purpose is in `checkout.title` (truncated to 120 characters) and `checkout.description`. `quote.metadataHash` is the keccak256 of its JCS canonical form, so the text the payer sees is the text the seller signed.
- **fromBlock:** `fromBlock` is an **unsigned** hint telling readers where to start the receipt log search.
- **Size:** a typical link is about 2 KB.

`encodeRequest` and `decodeRequest` are exported.

## Statuses

`readRequest` treats the link as untrusted input and checks it in this order:

| status | meaning |
| --- | --- |
| `unknown_store` | The link names a contract that isn't the known Nota store for its chain. A link never chooses the contract. |
| `wrong_chain` | The link is for a different chain than `publicClient`. |
| `tampered` | The metadata doesn't hash to `quote.metadataHash`, or it disagrees with the quote, chain, store, token or on-chain listing. This also covers a quote that is buyer-bound or carries an integrator fee. |
| `invalid_signature` | The quote isn't signed by the listing's seller, or the listing belongs to someone other than the seller named in the metadata. |
| `paid` | A `ReceiptPurchasedV2` log from the known store matches this request's purchaseRef, seller, listingId, amount, metadataHash and agentId. The receipt is returned with this status. |
| `blocked` | The reference was consumed on-chain, but no matching receipt was found. The request was **not** paid and can never be paid. |
| `listing_inactive` | The listing doesn't exist or has been deactivated. |
| `expired` | `expiresAt` has passed, judged by the latest block's timestamp. |
| `payable` | Everything above passed, and the contract's own `validateSignedReceiptPurchase` accepts it. |

Malformed input and unknown link versions throw `NotaError` with code `"invalid_link"`.

## Supported chains and addresses

| | Arbitrum One (42161) | Base (8453) | Arbitrum Sepolia (421614), **testnet** |
| --- | --- | --- | --- |
| NotaReceiptStore | `0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88` | `0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88` | `0x6b13e2077c84e1326111acBbb618E028723e2EA2` |
| PurchaseRefRegistry | `0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991` | `0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991` | `0x32aAeC7768adBBFD65C776b129616b8727d0c8bd` |
| USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (test USDC, no value) |
| Explorer | arbiscan.io | basescan.org | sepolia.arbiscan.io |

Arbitrum Sepolia is a testnet for trying the flow end to end with test USDC. Its deployment entry is marked `testnet: true`.

Before first use with a client, the SDK checks the store against this table and refuses to proceed if anything differs. It reads:
- `SETTLEMENT_TOKEN` and `PURCHASE_REF_REGISTRY`
- the EIP-712 name and version
- `SIGNED_RECEIPT_QUOTE_TYPEHASH` The table is exported as `NOTA_DEPLOYMENTS`, and the ABIs are exported too.

## Warning: the issuing wallet is a hot wallet

The key that signs requests sits in your agent's process or environment, and anyone who gets it can issue requests in your name. Payments go directly to that wallet's address. Keep only a little in it: enough ETH for gas, and sweep USDC out regularly.

## Limits

- **Requests expire within 24 hours.** The contract caps a quote's lifetime at 24h, and the default is 1 hour. To ask again later, create a new request.
- **The payer needs gas and two transactions.** They need ETH on the chain for gas, and usually send two transactions, a USDC `approve` and then the purchase. The approval is skipped if an exact-enough allowance already exists.
- **Minimum amount** is 100 base units (0.0001 USDC).
- **The receipt records what the issuer stated, not what it later did.** It proves that this payer paid this amount for the purpose the issuer signed. It says nothing about whether the issuer delivered.

## Known limitation: blocked requests

Anyone who holds a link can see its `purchaseRef`. A purchaseRef can be consumed only once, in a registry shared across listings. Someone else can therefore consume a request's reference against a listing of their own, either with `attestReceipt` or with a purchase on their own listing. After that, the original request can never be paid.

The SDK never treats "consumed" as "paid". It reports `paid` only for a matching `ReceiptPurchasedV2` log, found by filtering on the indexed `purchaseRef` and `seller` topics and then checking every other field. A request that was consumed without such a log is `blocked`:

- `readRequest` returns `blocked`.
- `payRequest` refuses it.
- `getReceipt` and `waitForReceipt` reject with `"purchase_ref_blocked"`, so an agent never concludes that it was funded.

The `fromBlock` hint in the link isn't signed. If the hint is missing or wrong, a paid request can read as `blocked`, but nothing can ever read as `paid` without a real matching receipt. An issuer that kept its `createRequest` result has the correct `fromBlock`, or can pass `fromBlock` explicitly.

**Remedy:** issue a new request. The griefer gains nothing except the ability to block a link they were handed, and it costs them gas.

## API summary

| function | returns |
| --- | --- |
| `setup({ walletClient, publicClient, listing })` | `{ listingId, txHash, listingHash }` |
| `prepareSetup({ publicClient, listing })` | the unsent `createListing` transaction |
| `createRequest({ walletClient \| account, publicClient, listingId, amount, purpose, expiresInSeconds?, agentId?, baseUrl? })` | `{ url, purchaseRef, quote, signature, metadata, fromBlock, chainId, store }` |
| `readRequest(urlOrPayload, { publicClient, payer?, fromBlock? })` | `{ status, request, receipt?, reason? }` |
| `payRequest({ walletClient, publicClient, request })` | `{ approveTxHash?, payTxHash, receipt }` |
| `preparePayCalls({ publicClient, request, payer })` | `{ calls: [{ to, data }], needsApproval }` |
| `waitForReceipt({ publicClient, request, fromBlock?, timeoutMs?, maxBlockRange? })` | `receipt` |
| `getReceipt({ publicClient, request, fromBlock?, maxBlockRange? })` | `receipt \| null` |

Log searches run in bounded block ranges (`maxBlockRange`, default 5000), so public RPCs with log-range caps work.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
ARBITRUM_RPC_URL=https://... BASE_RPC_URL=https://... ARBITRUM_SEPOLIA_RPC_URL=https://... npm test   # adds the anvil fork tests (needs Foundry)
```

Without the RPC URLs, the fork tests are reported as skipped. They never broadcast anything: they run against a local `anvil --fork-url`.

## License

Apache-2.0
