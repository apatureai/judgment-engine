import type { PassModelOverrides } from "./registry.js";

/**
 * Model-generation selection (TRD §7, #87). The judge's base generation is a
 * config swap behind the per-pass adapter (#26): `qwen3-vl` (the v1 default) and
 * `qwen3.5` (the natively-multimodal successor, GA Feb 2026) both serve on the
 * same DashScope OpenAI-compatible endpoint and map 1:1 onto the triage/deep
 * split. Selecting a generation only changes the resolved model ids: backend,
 * thinking flags, image budgeting (#69), and the deep-pass two-step (#29) are
 * unchanged.
 *
 * The default stays `qwen3-vl`: `qwen3.5` is opt-in and is to be promoted ONLY
 * via the eval-gated comparison (#48/#71/#78) on a frozen capture set, never
 * blind-swapped. The offline-batch eval run itself is the live seam.
 */
export type ModelGeneration = "qwen3-vl" | "qwen3.5";

/** No blind swap: the v1 default until the eval gate promotes a new anchor (#87). */
export const DEFAULT_MODEL_GENERATION: ModelGeneration = "qwen3-vl";

export interface GenerationConfig {
  /** Triage (fast) model id. */
  triageModel: string;
  /** Deep (Thinking) model id. */
  deepModel: string;
  /**
   * Whether the triage pass may request multimodal `json_object` on this
   * generation (#87 caveat). DashScope lists multimodal structured output only
   * for Qwen3-VL; on qwen3.5 the triage runs without `response_format` and relies
   * on the defensive JSON parse (which already fails open).
   */
  triageStructuredOutput: boolean;
}

/** Pinned model ids per generation (qwen3.5 snapshots pinned for reproducibility, #87). */
export const MODEL_GENERATIONS: Record<ModelGeneration, GenerationConfig> = {
  "qwen3-vl": {
    triageModel: "qwen3-vl-flash",
    deepModel: "qwen3-vl-plus",
    triageStructuredOutput: true,
  },
  "qwen3.5": {
    triageModel: "qwen3.5-flash-2026-02-23",
    deepModel: "qwen3.5-plus-2026-02-15",
    triageStructuredOutput: false,
  },
};

/**
 * Per-pass model overrides selecting a generation's ids. Composes with
 * `passModelsForTier` (#35) and `resolvePassModel` (#26); backend + thinking
 * flags come from the defaults, only the model id changes.
 */
export function passModelsForGeneration(generation: ModelGeneration): PassModelOverrides {
  const g = MODEL_GENERATIONS[generation];
  return {
    triage: { model: g.triageModel },
    deep: { model: g.deepModel },
  };
}
