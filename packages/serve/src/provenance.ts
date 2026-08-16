import { NO_MODEL_DISCLOSURE_PREFIX, type EngineReviewResult } from "@engine/types";
import { LocalEngineError } from "./errors.js";

/**
 * Where this server states whether anything judged a page.
 *
 * The stamp itself is `@engine/cli`'s `localJudgmentProvenance` /
 * `stampJudgmentProvenance`, shared verbatim with the terminal CLI so the two
 * front doors onto the same pipeline describe a run in one vocabulary rather
 * than two. All this module adds is the engine name and the publication guard.
 */

/** `engine` value for a review produced by the HTTP server. */
export const LOCAL_ENGINE_NAME = "verdict-http";

/**
 * Publication guard. Nothing leaves this server without saying how it was
 * produced, so a future code path that forgets to stamp fails the job loudly
 * instead of publishing a grade of unknown origin.
 */
export function assertAttested(result: EngineReviewResult): EngineReviewResult {
  const provenance = result.provenance;
  if (!provenance || typeof provenance.model_backed === "undefined") {
    throw new LocalEngineError(
      "unattested_result",
      "a review reached publication with no judgment provenance; refusing to serve a grade of unknown origin",
    );
  }
  if (
    provenance.model_backed === false &&
    !result.notReviewed.some((line) => line.startsWith(NO_MODEL_DISCLOSURE_PREFIX))
  ) {
    throw new LocalEngineError(
      "unattested_result",
      "a result nothing judged reached publication without its notReviewed disclosure",
    );
  }
  // The same guard, for the other half of the question (#165). `provenance` says
  // whether a model was called; `coverage` says what it was called ON, and only
  // the second one catches a green grade published over an empty capture.
  // Coverage is OPTIONAL on the wire, because a third-party engine may have no
  // way to report it, but it is MANDATORY for anything this server publishes:
  // every result here came through the orchestrator, which always knows.
  if (!result.coverage) {
    throw new LocalEngineError(
      "unattested_result",
      "a review reached publication without stating what it reviewed; refusing to serve a grade of unknown coverage",
    );
  }
  return result;
}
