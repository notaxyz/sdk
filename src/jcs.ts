/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * The Nota store commits to checkout metadata as `keccak256` over its JCS-canonicalized JSON, so
 * a reader can only re-derive `quote.metadataHash` from a document if it serializes it the exact
 * same way. Two details carry that weight:
 *
 *   - Object keys sort by UTF-16 code unit. JavaScript's own `<` on strings already compares by
 *     UTF-16 code unit, so the default comparison is the correct one rather than a coincidence.
 *   - Numbers serialize with ECMAScript `Number::toString`, which is what `JSON.stringify`
 *     produces. String escaping is likewise ECMAScript's, which JCS adopts.
 *
 * `undefined` properties are dropped, matching `JSON.stringify`. Anything JSON cannot represent
 * is rejected rather than silently coerced, because a coerced value would hash to a commitment
 * the seller never signed.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}
