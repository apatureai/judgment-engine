/**
 * Baseline change-detection (TRD §6.2, #89). The triage short-circuit (#28) is
 * the engine's main cost lever: when a route is "unchanged" vs its cached
 * baseline we skip the deep review. The naive form compared a single global
 * perceptual hash (pHash) and concluded "unchanged" on a match — but pHash keeps
 * only the top-left 8×8 low-frequency DCT block, so it is provably blind to
 * small/localized UI changes (a button shifting to a slightly different blue, a
 * text edit, a small spacing tweak). For a design-review product a false
 * "no change → skip" silently drops a real regression from review — the worst
 * failure direction.
 *
 * Fix: keep pHash as the CHEAP pre-filter, but never let a pHash *match* alone
 * conclude "unchanged".
 *   - pHash differs beyond threshold  → definitely changed → deep review (cheap).
 *   - pHash matches                    → only a CANDIDATE; confirm with a
 *     change-sensitive, tile-wise diff (SSIM ≥ ~0.99, or AA-aware pixel-diff
 *     ratio ≤ ~0.1%) before short-circuiting.
 *   - known-animated tiles (#13/#18)   → excluded so a carousel can't force a
 *     false "changed".
 *   - missing/ambiguous sensitive-diff → FAIL OPEN → deep review.
 *
 * This is a PURE seam: hashes + per-tile SSIM/diff scores in → decision out. The
 * real SSIM/pixel-diff + region masking run in the capture worker (the live
 * seam); this module is fully testable with fixtures, no browser or image lib.
 * Note the opposite sensitivity from the settle/stability gate (#15), which
 * WANTS a tolerant pHash to ignore render jitter — the two uses must not share
 * one coarse detector + threshold.
 */
import { hashesWithin } from "./stability.js";

/** UI rule of thumb: SSIM ≥ ~0.99 over a tile ⇒ no visible change. */
export const BASELINE_SSIM_THRESHOLD = 0.99;
/** AA-aware pixel-diff ratio ≤ ~0.1% of a tile's pixels ⇒ no visible change. */
export const BASELINE_DIFF_RATIO_THRESHOLD = 0.001;
/** Default max pHash hamming distance treated as a match (matches #15/#28). */
export const BASELINE_PHASH_THRESHOLD = 5;

/**
 * One tile's change-sensitive score (computed by the worker). Provide `ssim`
 * OR `diffRatio` (ssim wins if both present). A tile with neither is ambiguous.
 */
export interface TileChangeScore {
  /** Structural similarity in [0,1]; 1 = identical. */
  ssim?: number;
  /** AA-aware pixel-diff ratio in [0,1]; 0 = identical. */
  diffRatio?: number;
  /** Tile overlaps a known-animated region (#13/#18) → excluded from the decision. */
  animated?: boolean;
}

export interface BaselineChangeInput {
  /** Cached baseline perceptual hash (#34/#41); absent ⇒ cannot conclude unchanged. */
  baselinePhash?: string;
  currentPhash: string;
  /**
   * Per-tile change-sensitive scores (#17 tiling) used to CONFIRM a pHash match.
   * Absent/empty when the worker couldn't compute them ⇒ fail open.
   */
  tileScores?: readonly TileChangeScore[] | null;
}

export interface BaselineChangeOptions {
  phashThreshold?: number;
  ssimThreshold?: number;
  diffRatioThreshold?: number;
}

export type BaselineChangeReason =
  | "no_baseline"
  | "phash_mismatch"
  | "tile_changed"
  | "unconfirmable"
  | "confirmed_unchanged";

export interface BaselineChangeDecision {
  /** True ⇒ the route changed (or we can't prove it didn't) ⇒ run the deep review. */
  changed: boolean;
  reason: BaselineChangeReason;
}

/**
 * Classify one tile: `true` = changed, `false` = unchanged, `null` = no usable
 * score (ambiguous). SSIM takes precedence over diffRatio when both are present.
 */
function tileChanged(t: TileChangeScore, ssimThreshold: number, diffRatioThreshold: number): boolean | null {
  if (t.ssim !== undefined && Number.isFinite(t.ssim)) return t.ssim < ssimThreshold;
  if (t.diffRatio !== undefined && Number.isFinite(t.diffRatio)) return t.diffRatio > diffRatioThreshold;
  return null;
}

/**
 * Decide whether a route changed vs its baseline. pHash is the cheap pre-filter;
 * a pHash match is confirmed with the tile-wise sensitive diff before concluding
 * "unchanged". Fails open (changed=true) whenever it cannot positively confirm
 * an unchanged page.
 */
export function detectBaselineChange(
  input: BaselineChangeInput,
  options: BaselineChangeOptions = {},
): BaselineChangeDecision {
  const phashThreshold = options.phashThreshold ?? BASELINE_PHASH_THRESHOLD;
  const ssimThreshold = options.ssimThreshold ?? BASELINE_SSIM_THRESHOLD;
  const diffRatioThreshold = options.diffRatioThreshold ?? BASELINE_DIFF_RATIO_THRESHOLD;

  if (input.baselinePhash === undefined) return { changed: true, reason: "no_baseline" };

  // pHash mismatch ⇒ definitely changed; no sensitive diff needed.
  if (!hashesWithin(input.baselinePhash, input.currentPhash, phashThreshold)) {
    return { changed: true, reason: "phash_mismatch" };
  }

  // pHash match ⇒ only a CANDIDATE for unchanged. Confirm tile-wise.
  const tiles = input.tileScores;
  if (!tiles || tiles.length === 0) return { changed: true, reason: "unconfirmable" };

  const considered = tiles.filter((t) => !t.animated);
  if (considered.length === 0) return { changed: true, reason: "unconfirmable" };

  for (const t of considered) {
    const c = tileChanged(t, ssimThreshold, diffRatioThreshold);
    if (c === null) return { changed: true, reason: "unconfirmable" }; // ambiguous ⇒ fail open
    if (c) return { changed: true, reason: "tile_changed" }; // one localized change is enough
  }
  return { changed: false, reason: "confirmed_unchanged" };
}

/**
 * True only when EVERY route is positively confirmed unchanged (pHash match AND
 * tile-wise sensitive diff below the change threshold). Any changed,
 * unconfirmable, or baseline-less route makes this false (⇒ deep review).
 */
export function allRoutesConfirmedUnchanged(
  routes: readonly BaselineChangeInput[],
  options: BaselineChangeOptions = {},
): boolean {
  return routes.length > 0 && routes.every((r) => !detectBaselineChange(r, options).changed);
}
