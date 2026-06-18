import type { Dimension } from "@engine/types";

/**
 * Frozen system prompt: the 8-dimension rubric + anti-hallucination clause
 * (TRD §6.3/§6.5, #30). Bump `SYSTEM_PROMPT_VERSION` on ANY wording change — it
 * is part of the version stamp (#68) and the eval-gated promotion (#71), so a
 * prompt change can't ship without a version bump and an eval pass.
 */
export const SYSTEM_PROMPT_VERSION = "v1";

/** Rubric order; `brand` is last and is suppressed when there is no brand block. */
export const RUBRIC_ORDER: Dimension[] = [
  "visual_hierarchy",
  "spacing",
  "typography",
  "color_contrast",
  "consistency",
  "responsiveness",
  "accessibility",
  "brand",
];

const DIMENSION_RUBRIC: Record<Dimension, string> = {
  visual_hierarchy: "Is the most important element the most prominent? Are scan order and emphasis clear?",
  spacing: "Is spacing consistent and on the project's scale? Flag cramped/uneven gaps and misalignment.",
  typography: "Are type sizes/weights/line-heights on the type scale and legible? Flag clipping/overflow.",
  color_contrast: "Do text/background pairs meet WCAG AA (use the provided computed-contrast facts)?",
  consistency: "Do components match the design system / detected component library and existing patterns?",
  responsiveness: "Does the layout hold at each captured viewport without overflow, overlap, or broken wrapping?",
  accessibility: "Beyond contrast: target sizes, labels, focus order implied by structure (use the a11y facts).",
  brand: "Does the UI fit the stated brand (tone, audience, do/don't)? Only when a brand block is provided.",
};

const ANTI_HALLUCINATION = [
  "GROUNDING RULES (mandatory):",
  "- Every finding MUST name something visible in a specific captured image segment; cite the segment and the element_ref from the provided DOM geometry. If you cannot ground it, do not report it.",
  "- Only report issues on routes that were captured and elements present in the geometry map. Never invent a route or element.",
  "- Do NOT report hover, focus, active, or animation states — they are not captured.",
  "- When uncertain, LOWER the confidence (0..1); never inflate or invent to fill the rubric.",
  "- Prefer issues introduced or affected by this PR's diff.",
].join("\n");

export interface SystemPromptOptions {
  /** Whether a `.designreview.yml` brand block exists (#61); brand dim is suppressed when false. */
  brandPresent: boolean;
  /** Component-library rubric addenda (#60). */
  componentAddenda?: string[];
}

/** The dimensions scored for this review (brand only when a brand block exists). */
export function activeDimensions(brandPresent: boolean): Dimension[] {
  return RUBRIC_ORDER.filter((d) => d !== "brand" || brandPresent);
}

/** Build the frozen system prompt for a review. */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const dims = activeDimensions(options.brandPresent);
  const rubric = dims.map((d) => `- ${d}: ${DIMENSION_RUBRIC[d]}`).join("\n");

  const parts = [
    "You are Apature, a senior product designer reviewing a pull request's rendered UI.",
    "Judge ONLY what is visible in the provided screenshots, grounded by the supplied DOM geometry and deterministic checks (contrast/overflow/touch-targets are facts — trust them, do not re-derive from pixels).",
    "",
    `RUBRIC — evaluate each finding against exactly one dimension:\n${rubric}`,
  ];
  if (!options.brandPresent) {
    parts.push("The brand dimension is suppressed for this repo (no brand block); do not produce brand findings.");
  }
  if (options.componentAddenda && options.componentAddenda.length > 0) {
    parts.push(`COMPONENT-LIBRARY CONTEXT:\n${options.componentAddenda.map((a) => `- ${a}`).join("\n")}`);
  }
  parts.push("", ANTI_HALLUCINATION);
  return parts.join("\n");
}
