/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * The evidence bundle signature is computed over the JCS-canonical bytes of the
 * bundle with its `signature` object removed (TRD §3.2). Both Judgment Engine
 * (signer) and Entropy (verifier) must agree byte-for-byte, so this follows
 * RFC 8785 exactly: object members sorted by UTF-16 code unit of their key,
 * strings escaped minimally, and numbers rendered with the ECMAScript
 * `Number.prototype.toString` algorithm that JCS mandates.
 *
 * Pure and dependency-free: no network, no model, no I/O.
 */

/** Thrown when a value cannot be canonicalized (NaN, Infinity, non-finite). */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/** Serialize a JSON string per RFC 8785 §3.2.2.2 (minimal escaping). */
function canonicalString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const escape = ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/**
 * Serialize a number per RFC 8785 §3.2.2.3. JavaScript's own `String(Number)`
 * already implements the required ECMAScript number-to-string algorithm; we
 * only reject the non-finite values JSON cannot represent and normalize the
 * `-0` case to `0`.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number cannot be canonicalized: ${value}`);
  }
  if (value === 0) return "0";
  return String(value);
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return canonicalString(value);
    case "object":
      break;
    default:
      throw new CanonicalizationError(`unsupported value type: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }

  // Plain object: drop `undefined`-valued members (JSON.stringify parity), then
  // sort the remaining keys by UTF-16 code unit as RFC 8785 requires.
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child !== undefined) entries.push([key, child]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const members = entries.map(([key, child]) => `${canonicalString(key)}:${canonicalValue(child)}`);
  return `{${members.join(",")}}`;
}

/** Return the RFC 8785 canonical JSON string for a value. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value);
}

/** Return the RFC 8785 canonical JSON bytes (UTF-8) for a value. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
