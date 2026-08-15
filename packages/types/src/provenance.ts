/**
 * Judgment provenance: the in-band answer to "did anything actually judge this
 * page?"
 *
 * The CLI answers that question in its terminal report, which refuses to print
 * a grade for a run no model looked at. A caller of the HTTP job API never sees
 * that report: it sees one JSON payload and acts on it. So the same fact has to
 * travel INSIDE the payload, or for that caller it does not exist.
 *
 * The shape is deliberately the one `apatureai/bastion` already stamps on every
 * result it hands an agent (`model_backed` / `source` / `engine` / `model` /
 * `detail`), so a result that passes through both surfaces is described in one
 * vocabulary rather than two. Field names are snake_case for the same reason
 * they are there: this object rides out to agent-facing consumers verbatim.
 *
 * The rule every producer follows: say what this process actually knows, and
 * never more. `true` only when a model was called on a capture of the target
 * that was asked for; `false` only when this process can prove nothing judged
 * the page; `null` when it genuinely cannot tell.
 */

/**
 * What produced the judgment:
 *  - `model`:   a vision model was called on a capture of the target.
 *  - `canned`:  a real pipeline ran (capture, measurement) but the critique came
 *               from a deterministic stand-in, not from a model.
 *  - `fixture`: nothing ran; a stored result was replayed.
 *  - `unknown`: the producer did not attest, or attested that it cannot see how
 *               its own backend is configured.
 */
export type JudgmentSource = "model" | "canned" | "fixture" | "unknown";

/** In-band statement about where a judgment came from. */
export interface JudgmentProvenance {
  /**
   * `true` only when a model was called on a capture of the requested target.
   * `false` when the producer knows nothing judged the page. `null` when it
   * cannot tell. A consumer that requires a real judgment must treat anything
   * other than `true` as "not judged".
   */
  model_backed: boolean | null;
  source: JudgmentSource;
  /** Which surface produced the result, e.g. `verdict-cli`, `verdict-http`. */
  engine: string;
  /** The judge model, when one was called. `null` on every other path. */
  model: string | null;
  /** One sentence a human can read in a log with no other context. */
  detail: string;
}

/**
 * The prefix every "nothing judged this page" disclosure starts with. Stable on
 * purpose: it is what a consumer greps for and what a delivery surface
 * deduplicates on.
 */
export const NO_MODEL_DISCLOSURE_PREFIX = "[verdict] no model judged this page";

/**
 * The `notReviewed` line that accompanies `model_backed: false`, so the
 * structural disclosure and the prose disclosure say the same thing. It names
 * the `grade` field explicitly, because a wire result always carries one and a
 * reader who only looks there would otherwise read a fixture's grade as a
 * verdict about their page.
 */
export function noModelDisclosure(provenance: JudgmentProvenance): string {
  return (
    `${NO_MODEL_DISCLOSURE_PREFIX}: ${provenance.detail}. ` +
    "The capture, the geometry map and the measured facts in this result are real; the grade, " +
    "the narrative and any findings are not a judgment of this page."
  );
}

/**
 * True only when a model demonstrably judged the target. Anything else,
 * including the unknown remote case, is not a judgment a consumer may rely on.
 */
export function isModelBacked(provenance: JudgmentProvenance): boolean {
  return provenance.model_backed === true;
}

/**
 * True when the producer KNOWS nothing judged the page. Distinct from
 * `!isModelBacked`, which is also true for the unknown case: this is the
 * condition under which a grade and a narrative must be suppressed, because
 * they can be proven to describe nothing.
 */
export function isUnjudged(provenance: JudgmentProvenance): boolean {
  return provenance.model_backed === false;
}
