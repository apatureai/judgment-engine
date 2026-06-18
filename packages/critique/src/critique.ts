import type { CaptureImage, Critique, CritiqueOptions, Grade, RepoContext } from "@engine/types";
import type { ModelImage, ModelRequest } from "./model.js";
import { defaultModelFactory } from "./mock-model.js";
import { resolvePassModel, type ModelClientFactory, type PassModelOverrides } from "./registry.js";
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

function safeJson(text: string): { grade?: Grade; overall?: string } | null {
  try {
    return JSON.parse(text) as { grade?: Grade; overall?: string };
  } catch {
    return null;
  }
}

/**
 * The single critique entry point used by every surface (TRD §6.1). It resolves
 * the per-pass model config, builds the request, and routes through the swappable
 * `ModelClient` — a model swap (Qwen3-VL <-> Claude, DashScope <-> self-host) is a
 * config change with no change here or at any call site. The result is stamped
 * with the resolved model (#68). Prompt (#30), two-step JSON (#29), schema
 * validation (#31), and the hallucination gate (#32) build on this seam.
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

  const parsed = safeJson(response.text);

  return {
    grade: parsed?.grade ?? "ship",
    overall: parsed?.overall ?? `critique via ${config.model}`,
    findings: [],
    notReviewed: [],
    validation: { hallucinationDrops: 0, captureUnstable: false },
    metadata: buildResultMetadata({
      engineVersion: ENGINE_VERSION,
      model: config.model,
      promptVersion: PROMPT_VERSION,
      captureVersion: deps.captureVersion ?? DEFAULT_CAPTURE_VERSION,
      uiDnaVersion: context.uiDnaVersion,
    }),
  };
}
