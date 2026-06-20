/**
 * Shared design-token model (TRD §6). Every extractor (Tailwind, CSS custom
 * properties, tokens.json) normalizes into a flat `TokenMap` of dotted names ->
 * string values, which the deterministic context block (#63) serializes under
 * the model's prefix-cache boundary and Gate consumes via `RepoContext.tokens`.
 */
export type TokenMap = Record<string, string>;

/** A token source, highest precedence last (later sources override earlier). */
export interface TokenSource {
  /** Provenance label, e.g. "tailwind", "css-vars", "tokens.json". */
  source: string;
  tokens: TokenMap;
}

/**
 * Merge token sources in order; later sources win on key collisions. Keys are
 * returned sorted so the result is deterministic regardless of source order
 * within a precedence tier.
 */
export function mergeTokens(sources: TokenSource[]): TokenMap {
  const merged: TokenMap = {};
  for (const { tokens } of sources) {
    for (const [key, value] of Object.entries(tokens)) {
      merged[key] = value;
    }
  }
  return sortTokens(merged);
}

/** Return a new TokenMap with keys in sorted order (deterministic serialization). */
export function sortTokens(tokens: TokenMap): TokenMap {
  const out: TokenMap = {};
  for (const key of Object.keys(tokens).sort()) {
    out[key] = tokens[key] as string;
  }
  return out;
}
