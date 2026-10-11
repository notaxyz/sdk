import { encodeAbiParameters, keccak256, stringToBytes, type Address, type Hex } from "viem";

import { NotaError } from "./errors.js";

export const PURCHASE_REF_HASH_DOMAIN = "nota.purchaseRef.receipt.v1";
export const MAX_RAW_PURCHASE_REF_BYTES = 128;

export interface PurchaseRefInput {
  chainId: number;
  settlementToken: Address;
  seller: Address;
  /** 1 to 128 UTF-8 bytes. */
  rawPurchaseRef: string;
  /** 32-byte random salt. */
  nonce: Hex;
}

/**
 * Offline equivalent of `NotaReceiptStore.hashPurchaseRef`:
 * `keccak256(abi.encode("nota.purchaseRef.receipt.v1", chainid, token, seller, raw, nonce))`.
 * `listingId` is not part of the preimage; the contract only uses it to check seller ownership.
 */
export function hashPurchaseRef(input: PurchaseRefInput): Hex {
  assertRawPurchaseRef(input.rawPurchaseRef);
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) {
    throw new NotaError("invalid_argument", "purchaseRef nonce must be 32 bytes of hex");
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "string" },
        { type: "bytes32" },
      ],
      [
        PURCHASE_REF_HASH_DOMAIN,
        BigInt(input.chainId),
        input.settlementToken,
        input.seller,
        input.rawPurchaseRef,
        input.nonce,
      ],
    ),
  );
}

export function assertRawPurchaseRef(rawPurchaseRef: string): void {
  const length = stringToBytes(rawPurchaseRef).length;
  if (length < 1 || length > MAX_RAW_PURCHASE_REF_BYTES) {
    throw new NotaError(
      "invalid_argument",
      `rawPurchaseRef must be 1 to ${MAX_RAW_PURCHASE_REF_BYTES} UTF-8 bytes, got ${length}`,
    );
  }
}
