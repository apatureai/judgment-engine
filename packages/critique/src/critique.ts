import type { CaptureImage, Critique, CritiqueOptions, RepoContext } from "@engine/types";
import type { ModelImage, ModelRequest } from "./model.js";
import { defaultModelFactory } from "./mock-model.js";
import { resolvePassModel, type ModelClientFactory, type PassModelOverrides } from "./registry.js";
import { applyConfidenceCeiling } from "./confidence-ceiling.js";
import { hallucinationGate } from "./hallucination-gate.js";
import { postFilter } from "./post-filter.js";
import { parseCritiqueOutput } from "./schema.js";
import { buildResultMetadata } from "./version-stamp.js";

export const ENGINE_VERSION = "0.0.0";
export const PROMPT_VERSION = "stub@0";
const DEFAULT_CAPTURE_VERSION = "stub@0";

/** Injectable dependencies — the seam that keeps model backends swappable per pass. */
export interface CritiqueDeps {
  /** Build the model client for a resolved pass config (default: mock stand-in). */
  modelFactory?: ModelClientFactory;
  /** Per-pass model config overrides (model id / backend / thinking). */
  passModels?: PassModelOverrides;
  /** Capture version stamped on the result (from the capture that produced the images). */
  captureVersion?: string;
  /** Valid elementRef selectors from the geometry map (#18); enables the element_ref drop (#32). */
  geometrySelectors?: Iterable<string>;
}

function toModelImages(images: CaptureImage[]): ModelImage[] {
  return images.map((i) => ({ objectKey: i.objectKey, route: i.route, viewport: i.viewport }));
}

function buildRequest(
  model: string,
  thinking: boolean,
  images: CaptureImage[],
  context: RepoContext,
): ModelRequest {
  return {
    model,
    thinking,
    responseFormat: "json_object",
    messages: [
      { role: "system", content: "Apature design reviewer (stub prompt; #30 replaces this)." },
      { role: "user", content: `context:${context.contentHash}`, images: toModelImages(images) },
    ],
  };
}

/**
 * The single critique entry point used by every surface (TRD §6.1). It resolves
 * the per-pass model config, builds the request, and routes through the swappable
 * `ModelClient` — a model swap (Qwen3-VL <-> Claude, DashScope <-> self-host) is a
 * config change with no change here or at any call site. The model output is
 * Zod-validated (#31); the result is stamped with the resolved model (#68).
 * Two-step JSON (#29) and the hallucination gate (#32) build on this seam.
 */
export async function critique(
  images: CaptureImage[],
  context: RepoContext,
  options: CritiqueOptions,
  deps: CritiqueDeps = {},
): Promise<Critique> {
  const config = resolvePassModel(options.depth, deps.passModels);
  const client = (deps.modelFactory ?? defaultModelFactory)(config);
  const response = await client.complete(buildRequest(config.model, config.thinking, images, context));

  // #31: parse + Zod-validate; never hand prose downstream.
  const parsed = parseCritiqueOutput(response.text);
  const output = parsed.ok ? parsed.value : null;

  // #32: drop-and-count gate — clamp confidence, drop ungrounded findings.
  const gated = hallucinationGate(output?.findings ?? [], {
    capturedRoutes: images.map((i) => i.route),
    geometrySelectors: deps.geometrySelectors,
  });

  // #70: cap confidence when the capture was unstable, before the post-filter.
  const ceiling = options.confidenceCeiling;
  const capped = ceiling !== undefined ? applyConfidenceCeiling(gated.findings, ceiling) : gated.findings;

  // #33: trust-budget post-filter (confidence floor, dedupe, cap).
  const findings = postFilter(capped);

  return {
    grade: output?.grade ?? "ship",
    overall: output?.overall ?? `critique via ${config.model}`,
    findings,
    notReviewed: output?.notReviewed ?? [],
    validation: {
      hallucinationDrops: gated.hallucinationDrops,
      captureUnstable: ceiling !== undefined,
    },
    metadata: buildResultMetadata({
      engineVersion: ENGINE_VERSION,
      model: config.model,
      promptVersion: PROMPT_VERSION,
      captureVersion: deps.captureVersion ?? DEFAULT_CAPTURE_VERSION,
      uiDnaVersion: context.uiDnaVersion,
    }),
  };
}
