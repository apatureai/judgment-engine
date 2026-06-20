import { createHash } from "node:crypto";
import type { BrandBlock } from "./brand.js";
import type { ComponentLibrary } from "./component-detection.js";
import { sortTokens, type TokenMap } from "./tokens.js";

/**
 * Deterministic context-block assembly + content-hash cache invalidation
 * (TRD §6/§7, #63). All extractors are assembled into ONE block, serialized
 * deterministically (recursively sorted keys, no timestamps, sorted arrays) and
 * placed under the model's prefix-cache boundary. The cache is keyed on the
 * content hash of the assembled inputs — NOT a wall-clock TTL — so it stays
 * warm until the repo's tokens/config actually change.
 *
 * Bump `CONTEXT_VERSION` when the serialization format changes; it is part of
 * the hashed payload, so a format change busts every cache entry.
 */
export const CONTEXT_VERSION = "1";

export interface ContextBlockInput {
  /** Merged design tokens from all sources. */
  tokens: TokenMap;
  brand: BrandBlock | null;
  componentLibraries: ComponentLibrary[];
  uiDnaVersion: string | null;
  /** Affected routes for this review (optional). */
  routes?: string[];
}

export interface ContextBlock {
  contextVersion: string;
  /** sha256 of the serialized block — the prefix-cache key. */
  contentHash: string;
  /** Deterministic serialization placed under the model prefix-cache boundary. */
  serialized: string;
}

/** Recursively sort object keys so serialization is insertion-order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic, byte-stable serialization of the assembled context. */
export function serializeContextBlock(input: ContextBlockInput): string {
  const canonical = {
    contextVersion: CONTEXT_VERSION,
    tokens: sortTokens(input.tokens),
    brand: input.brand,
    componentLibraries: [...input.componentLibraries]
      .map((l) => ({ id: l.id, rubricAddendum: l.rubricAddendum }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    uiDnaVersion: input.uiDnaVersion ?? null,
    routes: input.routes ? [...input.routes].sort() : [],
  };
  return JSON.stringify(canonicalize(canonical));
}

/** Assemble the context block + its content hash (cache key) + version stamp. */
export function buildContextBlock(input: ContextBlockInput): ContextBlock {
  const serialized = serializeContextBlock(input);
  const contentHash = createHash("sha256").update(serialized).digest("hex");
  return { contextVersion: CONTEXT_VERSION, contentHash, serialized };
}
