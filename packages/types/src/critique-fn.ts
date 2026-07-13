import type { Capture, CaptureImage } from "./capture.js";
import type { Critique } from "./findings.js";

/**
 * The core contract (TRD §2): `critique(images, context) -> Findings`. The
 * `context` is the deterministic, content-hashed repo context block (TRD §6)
 * placed under the model's prefix-cache boundary.
 */
export type ReviewDepth = "triage" | "deep";

export interface RepoContext {
  installationId: string;
  repository: { owner: string; name: string; defaultBranch: string };
  /** Brand block from .designreview.yml (TRD §6). */
  brand: string | null;
  /** Resolved design tokens (Tailwind/CSS vars/tokens.json), name -> value. */
  tokens: Record<string, string>;
  /** UI-DNA genome version resolved for this repo, or null. */
  uiDnaVersion: string | null;
  /** Deterministic content hash of the assembled context block (cache key). */
  contentHash: string;
}

/**
 * Build/runtime diagnostics Gate's Action path extracted from a locally-served
 * preview (failed compiles, hydration mismatches, asset/chunk errors,
 * deprecations, warnings) and sent on the review request (cross-repo, gate #70
 * U1). They are design-quality signals a screenshot alone hides; the engine
 * folds them into the deep-pass prompt as GROUNDED build facts (alongside the
 * #19 deterministic facts). Mirrors Gate's `PreviewBuildFact` shape exactly so
 * the additive request field stays wire-compatible. Optional — tolerate absence.
 */
export type PreviewBuildFactKind = "compile_error" | "hydration" | "asset_error" | "deprecation" | "warning";

export interface PreviewBuildFact {
  kind: PreviewBuildFactKind;
  message: string;
  source?: string;
}

export interface CritiqueOptions {
  depth: ReviewDepth;
  /** The capture was unstable; the promoted report supplies the numeric ceiling. */
  captureUnstable?: boolean;
  /**
   * Build/runtime facts from Gate's preview-command supervisor (gate #70 U1).
   * Additive/optional; absence changes nothing. Folded into the deep-pass prompt
   * as grounded build signals — a finding citing one still grounds on a captured
   * route + element_ref (the drop-and-count gate #32 is unchanged).
   */
  previewBuildFacts?: PreviewBuildFact[];
}

/** The core contract. */
export type Critique_Fn = (
  images: CaptureImage[],
  context: RepoContext,
  options: CritiqueOptions,
) => Promise<Critique>;

/** Convenience: the inputs a critique pass needs alongside images. */
export interface CritiqueInput {
  capture: Capture;
  context: RepoContext;
  options: CritiqueOptions;
}
