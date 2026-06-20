/**
 * Implicit feedback detection (TRD §8, #39). The ONLY implicit-positive signal is
 * a **suggestion string-match in a later diff**: if a specific class/token/value
 * from the finding's suggestion appears in a subsequent diff, the fix was likely
 * applied. The weaker "touched-element" heuristic is intentionally NOT used — it
 * conflates rebases/refactors with real fixes. The implicit-negative signal is
 * "merged with blockers unresolved".
 *
 * Pure detection; the worker records the result via `FeedbackStore` (#38).
 */

/**
 * Extract the *significant*, matchable tokens from a suggestion — CSS classes,
 * hex colors, sized values, quoted strings, and hyphenated/dotted identifiers.
 * Plain English words are excluded so "make it nicer" can't false-positive.
 */
export function extractSuggestionTokens(suggestion: string): string[] {
  const tokens = new Set<string>();
  const add = (re: RegExp): void => {
    for (const m of suggestion.matchAll(re)) {
      const t = (m[1] ?? m[0]).trim().toLowerCase();
      if (t.length >= 3) tokens.add(t);
    }
  };
  add(/\.[a-z][\w-]{2,}/gi); // .css-class
  add(/#[0-9a-f]{3,8}\b/gi); // #hex color
  add(/\b\d+(?:px|rem|em|%)\b/gi); // 16px / 1rem
  add(/["'`]([^"'`]{3,})["'`]/g); // "quoted value"
  add(/\b[a-z]+(?:-[a-z0-9]+)+\b/gi); // gap-4, text-sm (hyphenated utility/token)
  return [...tokens];
}

/**
 * True when a significant suggestion token string-matches the later diff's added
 * text. Conservative: requires at least one structured token to match.
 */
export function suggestionMatchesDiff(suggestion: string, laterDiffAddedText: string): boolean {
  const haystack = laterDiffAddedText.toLowerCase();
  return extractSuggestionTokens(suggestion).some((t) => haystack.includes(t));
}

/** Whether the PR merged with at least one blocker finding still unresolved. */
export function mergedWithBlockersUnresolved(input: {
  merged: boolean;
  unresolvedBlockerCount: number;
}): boolean {
  return input.merged && input.unresolvedBlockerCount > 0;
}
