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

export interface CritiqueOptions {
  depth: ReviewDepth;
  /** Confidence ceiling applied when the capture was unstable (TRD §5). */
  confidenceCeiling?: number;
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
