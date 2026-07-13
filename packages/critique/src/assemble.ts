import type {
  CalibrationRuntimeBinding,
  ConfidenceUnavailableReason,
  Critique,
  Finding,
} from "@engine/types";
import {
  applyCalibrationBinding,
  calibrationBindingMatches,
  enforceBlockingThreshold,
} from "./calibration-binding.js";
import { applyConfidenceCeiling } from "./confidence-ceiling.js";
import { ENGINE_VERSION, PROMPT_VERSION, RUBRIC_VERSION } from "./critique.js";
import type { DeepPassRouteResult } from "./deep-pass.js";
import { reconcileGrade, worstGrade } from "./grade.js";
import { hallucinationGate } from "./hallucination-gate.js";
import { postFilter } from "./post-filter.js";
import { buildResultMetadata } from "./version-stamp.js";

/**
 * Assemble per-route deep-pass outputs (#29) into ONE final `Critique`. The deep
 * pass runs once per route and returns a `CritiqueOutput | null` per route; but
 * the validation tail must run ONCE, GLOBALLY over the merged findings:
 *   - hallucination gate (#32) against ALL captured routes + geometry,
 *   - confidence ceiling (#70) when the capture was unstable,
 *   - post-filter (#33) — confidence floor + dedupe across viewports + the
 *     global cap (1 blocker + 6), which is meaningless per-route,
 *   - version stamp (#68).
 * Without this, nothing turned `runDeepPass` results into a wire-ready Critique
 * (the cross-route cap/dedupe/gate were never applied). `critique()` does this
 * tail for its single stub pass; this is the multi-route equivalent.
 *
 * Pure. A route whose coercion failed (`output: null`, no partial #31) contributes
 * no findings and is recorded in `notReviewed`.
 */
export interface AssembleCritiqueDeps {
  /** Every captured route — the hallucination gate drops findings on uncaptured routes (#32). */
  capturedRoutes: string[];
  /** Valid elementRef selectors from the geometry map (#18) for the element_ref drop (#32). */
  geometrySelectors?: Iterable<string>;
  /** Confidence ceiling when the capture was visually unstable (#15/#70). */
  captureUnstable?: boolean;
  /** Eval-owned, already validated promoted calibration binding (#160). */
  calibration?: CalibrationRuntimeBinding;
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
  /** Engine-side not-reviewed reasons (fork skip, off-domain, capture failures) to carry through. */
  notReviewed?: string[];
  /** Resolved per-pass model id for the stamp (#26/#68). */
  model: string;
  engineVersion?: string;
  promptVersion?: string;
  captureVersion: string;
  uiDnaVersion: string | null;
}

export function assembleCritique(routes: DeepPassRouteResult[], deps: AssembleCritiqueDeps): Critique {
  const valid = routes.filter((r): r is DeepPassRouteResult & { output: NonNullable<DeepPassRouteResult["output"]> } => r.output !== null);

  const merged: Finding[] = valid.flatMap((r) => r.output.findings as Finding[]);

  // Global validation tail (order matches critique(): gate -> ceiling -> filter).
  const gated = hallucinationGate(merged, {
    capturedRoutes: deps.capturedRoutes,
    geometrySelectors: deps.geometrySelectors,
  });
  const engineVersion = deps.engineVersion ?? ENGINE_VERSION;
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const calibration = deps.calibration && calibrationBindingMatches(deps.calibration, {
    model: deps.model,
    promptVersion,
    engineVersion,
    captureVersion: deps.captureVersion,
    rubricVersion: RUBRIC_VERSION,
  }) ? deps.calibration : undefined;
  const calibrated = calibration
    ? applyCalibrationBinding(gated.findings, calibration)
    : gated.findings;
  const capped = deps.captureUnstable && calibration
    ? applyConfidenceCeiling(calibrated, calibration.thresholds.unstableCaptureMaxConfidence)
    : calibrated;
  const filtered = postFilter(capped, {
    ...(calibration
      ? { minConfidence: calibration.thresholds.postFilterMinConfidence, useConfidence: true }
      : {}),
  });
  const findings = calibration ? enforceBlockingThreshold(filtered, calibration) : filtered;

  // Worst route grade, then floored to what the surviving findings support (#106).
  const reconciledGrade = reconcileGrade(worstGrade(valid.map((r) => r.output.grade)), findings);
  const blockingEnabled = calibration?.promotionMode === "blocking";
  const grade = !blockingEnabled && reconciledGrade === "blocked" ? "needs_work" : reconciledGrade;
  const overall = dedupeStrings(valid.map((r) => r.output.overall).filter((s) => s.trim().length > 0)).join(" ");

  const notReviewed = dedupeStrings([
    ...(deps.notReviewed ?? []),
    ...valid.flatMap((r) => r.output.notReviewed),
    ...routes.filter((r) => r.output === null).map((r) => `${r.route}: no valid critique`),
  ]);

  return {
    grade,
    overall,
    findings,
    notReviewed,
    validation: {
      hallucinationDrops: gated.hallucinationDrops,
      captureUnstable: deps.captureUnstable === true,
    },
    metadata: buildResultMetadata({
      engineVersion,
      model: deps.model,
      promptVersion,
      captureVersion: deps.captureVersion,
      uiDnaVersion: deps.uiDnaVersion,
    }),
    ...(calibration ? { calibration: calibration.reference } : {}),
    blockingEnabled,
    ...(!calibration
      ? {
          confidenceUnavailableReason:
            deps.calibration ? "mismatched_calibration_report" : deps.confidenceUnavailableReason ?? "missing_calibration_report",
        }
      : {}),
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
