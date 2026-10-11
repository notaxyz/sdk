import { parseAbi, parseAbiItem } from "viem";

/** The subset of NotaReceiptStore this SDK uses, plus every custom error so reverts decode. */
export const notaReceiptStoreAbi = parseAbi([
  "struct SignedReceiptQuote { uint256 listingId; address buyer; bytes32 purchaseRef; uint256 amount; bytes32 metadataHash; bytes32 agentId; address integratorFeeRecipient; uint256 integratorFeeAmount; uint64 issuedAt; uint64 expiresAt; }",
  "struct Listing { address seller; bytes32 listingHash; uint256 unitPrice; bool active; uint8 mode; }",
  "struct SignedReceiptPurchaseValidation { uint256 grossAmount; uint256 protocolFee; uint256 integratorFee; uint256 sellerNet; address protocolFeeRecipient; address integratorFeeRecipient; address seller; bytes32 listingHash; address verifiedSigner; }",

  "function createListing(bytes32 listingHash, uint256 unitPrice, uint8 mode) returns (uint256 listingId)",
  "function setListingActive(uint256 listingId, bool active)",
  "function getListing(uint256 listingId) view returns (Listing)",
  "function nextListingId() view returns (uint256)",
  "function hashPurchaseRef(address seller, uint256 listingId, string rawPurchaseRef, bytes32 purchaseRefNonce) view returns (bytes32)",
  "function hashSignedReceiptQuote(SignedReceiptQuote quote) view returns (bytes32)",
  "function validateSignedReceiptPurchase(SignedReceiptQuote quote, bytes sellerSignature, address expectedBuyer, address claimedSigner) view returns (SignedReceiptPurchaseValidation)",
  "function purchaseSignedReceipt(SignedReceiptQuote quote, bytes sellerSignature, address claimedSigner) returns (uint256 receiptId)",
  "function attestReceipt(uint256 listingId, address buyer, bytes32 purchaseRef, bytes32 metadataHash, bytes32 agentId, bytes32 paymentRef) returns (uint256 receiptId)",
  "function SETTLEMENT_TOKEN() view returns (address)",
  "function PURCHASE_REF_REGISTRY() view returns (address)",
  "function EIP712_NAME() view returns (string)",
  "function EIP712_VERSION() view returns (string)",
  "function purchasesPaused() view returns (bool)",
  "function listingCreationPaused() view returns (bool)",

  "event ListingCreated(uint256 indexed listingId, address indexed seller, bytes32 indexed listingHash, uint256 unitPrice, uint8 mode)",
  "event ReceiptPurchasedV2(uint256 receiptId, address indexed seller, address indexed buyer, uint256 listingId, bytes32 indexed purchaseRef, uint256 amount, bytes32 metadataHash, bytes32 agentId)",

  "error ListingNotFound()",
  "error NotListingSeller()",
  "error ListingInactive()",
  "error ListingRequiresSignedQuote()",
  "error InvalidParams()",
  "error InvalidPurchaseRef()",
  "error PurchaseRefAlreadyUsed()",
  "error QuoteExpired()",
  "error InvalidQuoteSigner()",
  "error QuoteBuyerMismatch()",
  "error IntegratorFeeTooHigh()",
  "error ListingCreationPaused()",
  "error PurchasesPaused()",
  "error QuoteSignerUpdatesPaused()",
  "error AmountOutOfBounds()",
  "error QuoteExpiryTooLong()",
  "error SellerListingLimitReached()",
  "error RenounceWhilePausedDisabled()",
  "error QuoteSignerLimitReached()",
  "error PriceMismatch()",
]);

/** Standalone event item so `getLogs` returns typed args. */
export const receiptPurchasedV2Event = parseAbiItem(
  "event ReceiptPurchasedV2(uint256 receiptId, address indexed seller, address indexed buyer, uint256 listingId, bytes32 indexed purchaseRef, uint256 amount, bytes32 metadataHash, bytes32 agentId)",
);

export const listingCreatedEvent = parseAbiItem(
  "event ListingCreated(uint256 indexed listingId, address indexed seller, bytes32 indexed listingHash, uint256 unitPrice, uint8 mode)",
);

export const purchaseRefRegistryAbi = parseAbi([
  "function isConsumed(bytes32 purchaseRef) view returns (bool)",
  "function consumedBy(bytes32 purchaseRef) view returns (address)",
  "function authorizedConsumers(address consumer) view returns (bool)",
  "error UnauthorizedConsumer(address consumer)",
  "error InvalidPurchaseRef()",
  "error PurchaseRefAlreadyConsumed(bytes32 purchaseRef, address consumer)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** `ListingMode.SignedQuoteOnly` in the contract's enum. */
export const LISTING_MODE_SIGNED_QUOTE_ONLY = 1;
