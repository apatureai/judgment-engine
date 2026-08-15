import type { LocalReviewRequest } from "@engine/cli";
import type { ContextBlockInput } from "@engine/context";
import type { JobRecord } from "@engine/jobs";
import { toReviewInput } from "@engine/runtime/input";
import { LocalEngineError } from "./errors.js";

/**
 * Turn a durable job into the input the local pipeline runs.
 *
 * The submitted payload is Gate's `POST /jobs` contract verbatim, parsed by the
 * SAME `toReviewInput` the production composition root uses, so this server is
 * a service Gate can actually be pointed at rather than a private dialect. That
 * function also does the two checks a local server must not skip: the request's
 * `installationId` and `depth` are verified against the HMAC-scoped durable job
 * rather than trusted from caller-controlled JSON.
 *
 * Everything Gate cannot send is layered on here from the operator's own
 * configuration: the contract carries design tokens and a brand string, but no
 * component libraries and no `package.json`, so a `--context-dir` fills those in
 * from the repository the operator pointed at.
 */

export interface LocalRequestOptions {
  /** Design context loaded from `--context-dir`, if the operator configured one. */
  repoContext?: ContextBlockInput;
  /** Retention advertised on the wire result. */
  screenshotRetentionSeconds?: number;
  /** Capture each page twice and compare the bytes. */
  verifyStability?: boolean;
  /** Object-key prefix for this job's screenshots. */
  keyPrefix: string;
}

/**
 * Request-supplied context wins wherever the request actually supplied
 * something; the operator's directory fills the rest. Neither one is silently
 * discarded, and a review with no context at all is still a review, just a less
 * grounded one.
 */
function mergeContext(
  fromRequest: ContextBlockInput,
  repo: ContextBlockInput | undefined,
): ContextBlockInput {
  if (!repo) return fromRequest;
  return {
    tokens: Object.keys(fromRequest.tokens).length > 0 ? fromRequest.tokens : repo.tokens,
    brand: fromRequest.brand ?? repo.brand,
    componentLibraries:
      fromRequest.componentLibraries.length > 0
        ? fromRequest.componentLibraries
        : repo.componentLibraries,
    uiDnaVersion: fromRequest.uiDnaVersion,
    ...(fromRequest.routes ? { routes: fromRequest.routes } : {}),
  };
}

export function toLocalReviewRequest(
  job: JobRecord,
  options: LocalRequestOptions,
): LocalReviewRequest {
  let input;
  try {
    input = toReviewInput(job);
  } catch (error) {
    // A malformed submission is a typed failure, never a review of nothing.
    throw new LocalEngineError(
      "invalid_review_request",
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    url: input.url,
    routes: input.captureContext.routes,
    viewports: input.captureContext.viewports,
    darkMode: input.captureContext.darkMode,
    isFork: input.captureContext.isFork,
    installationId: input.captureContext.installationId,
    depth: input.depth,
    context: mergeContext(input.context, options.repoContext),
    ...(input.previewBuildFacts ? { previewBuildFacts: input.previewBuildFacts } : {}),
    ...(options.verifyStability !== undefined ? { verifyStability: options.verifyStability } : {}),
    screenshotRetentionSeconds: options.screenshotRetentionSeconds ?? 0,
    keyPrefix: options.keyPrefix,
  };
}
