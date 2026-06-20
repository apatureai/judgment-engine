import type { Critique, Critique_Fn } from "@engine/types";

/**
 * Critique seam — the core contract `critique(images, context) -> Findings`
 * (TRD §2). EM0 scaffold stub returning a deterministic empty critique so the
 * pipeline wires end to end; EM2 (#26-#35 Qwen3-VL passes, #31/#32 validation,
 * #33 post-filter, #70 confidence ceiling) replaces the body with the real model.
 */
export const ENGINE_VERSION = "0.0.0";
export const PROMPT_VERSION = "stub@0";

export const critique: Critique_Fn = async (_images, context, _options): Promise<Critique> => {
  return {
    grade: "ship",
    overall: "stub critique (EM0 scaffold)",
    findings: [],
    notReviewed: [],
    validation: { hallucinationDrops: 0, captureUnstable: false },
    metadata: {
      engineVersion: ENGINE_VERSION,
      model: "stub",
      promptVersion: PROMPT_VERSION,
      captureVersion: "stub@0",
      uiDnaVersion: context.uiDnaVersion,
    },
  };
};
