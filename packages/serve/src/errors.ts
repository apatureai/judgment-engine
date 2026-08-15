/**
 * Typed failures for the local HTTP deployment.
 *
 * The rule this file enforces: when the HTTP path cannot do something, it says
 * so. It never returns a well-formed result with an empty `findings` array,
 * because an empty result is indistinguishable from a clean review and is the
 * exact defect the stub processor used to ship. A thrown `LocalEngineError`
 * fails the job, and `GET /jobs/:id` then answers `{"state":"failed","error":
 * "<code>: <reason>"}` rather than `{"state":"completed"}` over nothing.
 */

export type LocalEngineErrorCode =
  /** The submitted review request is not the contract the engine accepts. */
  | "invalid_review_request"
  /** Chromium could not be launched, so nothing could be captured. */
  | "capture_unavailable"
  /** A result reached publication without a judgment-provenance stamp. */
  | "unattested_result";

export class LocalEngineError extends Error {
  constructor(
    readonly code: LocalEngineErrorCode,
    reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "LocalEngineError";
  }
}
