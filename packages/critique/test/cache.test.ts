import { describe, expect, it } from "vitest";
import { cachePrefix, cachedInputTokens, isCacheHit } from "../src/index.js";

describe("prefix-cache layout (#34)", () => {
  it("produces a byte-identical prefix across two reviews of the same repo state", () => {
    const systemPrompt = "rubric v1";
    const contextBlock = '{"contextVersion":"1","tokens":{"color.a":"#fff"}}';

    // Two PRs, same repo state -> identical cacheable prefix.
    const prefixA = cachePrefix(systemPrompt, contextBlock);
    const prefixB = cachePrefix(systemPrompt, contextBlock);
    expect(prefixB).toBe(prefixA);

    // Volatile content (route/diff/images) is NOT in the prefix, so it doesn't bust the cache.
    expect(prefixA).not.toContain("/pricing");
    expect(prefixA).toContain(contextBlock);
  });

  it("changes when the repo's context block changes (content-hash invalidation)", () => {
    const a = cachePrefix("r", '{"tokens":{"x":"1"}}');
    const b = cachePrefix("r", '{"tokens":{"x":"2"}}');
    expect(b).not.toBe(a);
  });

  it("reads the cache-hit signal from the model usage", () => {
    expect(cachedInputTokens({ cachedTokens: 1500 })).toBe(1500);
    expect(isCacheHit({ cachedTokens: 1500 })).toBe(true);
    expect(isCacheHit({ cachedTokens: 0 })).toBe(false);
  });
});
