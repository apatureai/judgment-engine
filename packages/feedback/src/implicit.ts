/**
 * Implicit feedback detection (TRD §8, #39). The ONLY implicit-positive signal is
 * a **suggestion string-match in a later diff**: if a specific class/token/value
 * from the finding's suggestion appears in a subsequent diff, the fix was likely
 * applied. The weaker "touched-element" heuristic is intentionally NOT used, since it
 * conflates rebases/refactors with real fixes. The implicit-negative signal is
 * "merged with blockers unresolved".
 *
 * Pure detection; the worker records the result via `FeedbackStore` (#38).
 */

/**
 * Extract the *significant*, matchable tokens from a suggestion: CSS classes,
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

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `token` appears as a WHOLE token in `haystack`, i.e. not flanked by a
 * character from the same token alphabet (`[\w#.%-]`). A plain substring test
 * would false-positive on a DIFFERENT value: `16px` inside `116px`, or `gap-4`
 * inside `gap-40`, labelling a fix "applied" when a different value was written.
 * The flank check makes "the value appears in the diff" mean what it says.
 */
function tokenAppearsIn(token: string, haystack: string): boolean {
  return new RegExp(`(?<![\\w#.%-])${escapeRegExp(token)}(?![\\w#.%-])`).test(haystack);
}

/**
 * True when a significant suggestion token appears (as a whole token) in the
 * later diff's added text. Conservative: requires at least one structured token
 * to match, and each token must match as a unit (never as a substring of a
 * different value).
 */
export function suggestionMatchesDiff(suggestion: string, laterDiffAddedText: string): boolean {
  const haystack = laterDiffAddedText.toLowerCase();
  return extractSuggestionTokens(suggestion).some((t) => tokenAppearsIn(t, haystack));
}

/** Whether the PR merged with at least one blocker finding still unresolved. */
export function mergedWithBlockersUnresolved(input: {
  merged: boolean;
  unresolvedBlockerCount: number;
}): boolean {
  return input.merged && input.unresolvedBlockerCount > 0;
}
