/**
 * Small type guards shared across the context extractors.
 *
 * `isRecord` was copy-pasted, byte-identical, into brand.ts and tokens-json.ts.
 * Single-sourced here so the extractors share one plain-object check.
 */

/** True for a plain object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
