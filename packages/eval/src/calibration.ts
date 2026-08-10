/**
 * Judge confidence calibration (#107). Pure eval stats over already-labeled
 * `{ confidence, correct }` pairs: a finding's verbalized confidence (0..1,
 * #33/#70) vs whether it matched golden ground truth (#45). NO live model.
 *
 * The 2025-26 literature is consistent: LLM/VLM-as-judge verbalized confidence
 * is severely overconfident and saturated (clusters at 0.9-1.0 while accuracy is
 * far lower; reported ECE 39-74%). `CalibrationReportV1` serializes the map and
 * thresholds derived from this measured reliability evidence. No serving path
 * may fall back to the historical hand-picked floor/ceiling.
 *
 * Provides:
 *   - `expectedCalibrationError(pairs, bins?)`: binned ECE + a reliability table
 *     (per-bin predicted-mean vs empirical-correct-rate + count).
 *   - `brierScore(pairs)`: mean squared error of confidence vs outcome.
 *   - `bootstrapEceCI(pairs, bins?, options?)`: seeded percentile CI on ECE,
 *     reusing the #46 mulberry32 bootstrap.
 *   - `fitMonotonicCalibration(pairs)`: isotonic regression (PAVA) mapping raw
 *     verbalized confidence -> calibrated probability; identity when unfit.
 *
 * Sources (accessed 2026-06-21): arXiv:2508.06225 (ECE/ACE/MCE/Brier/NLL),
 * arXiv:2509.25532 (saturated verbalized confidence + post-hoc calibration).
 */

import { mulberry32 } from "./rng.js";

/** One labeled prediction: a finding's verbalized confidence vs its correctness. */
export interface CalibrationPair {
  /** Verbalized confidence in [0, 1]. */
  confidence: number;
  /** Did the finding match golden ground truth (#45)? */
  correct: boolean;
}

/** A single reliability-table row (one confidence bin). */
export interface ReliabilityBin {
  /** Inclusive lower edge of the bin in [0, 1]. */
  lower: number;
  /** Exclusive upper edge (inclusive for the final bin). */
  upper: number;
  /** Number of pairs whose confidence fell in this bin. */
  count: number;
  /** Mean predicted confidence of the pairs in this bin (NaN-safe: 0 when empty). */
  predictedMean: number;
  /** Empirical correct-rate of the pairs in this bin (0 when empty). */
  empiricalRate: number;
}

export interface CalibrationReport {
  /** Expected Calibration Error: count-weighted mean |predictedMean - empiricalRate|. */
  ece: number;
  /** Total number of pairs scored. */
  total: number;
  /** Per-bin reliability table (length === bins). */
  reliability: ReliabilityBin[];
}

const DEFAULT_BINS = 10;

function asOutcome(correct: boolean): number {
  return correct ? 1 : 0;
}

/**
 * Equal-width reliability binning of [0, 1] into `bins` bins. A confidence of
 * exactly 1 lands in the final bin (upper edge inclusive there only).
 */
function buildReliability(pairs: readonly CalibrationPair[], bins: number): ReliabilityBin[] {
  if (!Number.isInteger(bins) || bins < 1) throw new Error("bins must be a positive integer");
  const width = 1 / bins;
  const sumConf = Array<number>(bins).fill(0);
  const sumCorrect = Array<number>(bins).fill(0);
  const count = Array<number>(bins).fill(0);

  for (const { confidence, correct } of pairs) {
    if (confidence < 0 || confidence > 1 || !Number.isFinite(confidence)) {
      throw new Error(`confidence ${confidence} out of range [0, 1]`);
    }
    let b = Math.floor(confidence / width);
    if (b >= bins) b = bins - 1; // confidence === 1
    sumConf[b] = (sumConf[b] ?? 0) + confidence;
    sumCorrect[b] = (sumCorrect[b] ?? 0) + asOutcome(correct);
    count[b] = (count[b] ?? 0) + 1;
  }

  const table: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b++) {
    const c = count[b] ?? 0;
    table.push({
      lower: b * width,
      upper: (b + 1) * width,
      count: c,
      predictedMean: c === 0 ? 0 : (sumConf[b] ?? 0) / c,
      empiricalRate: c === 0 ? 0 : (sumCorrect[b] ?? 0) / c,
    });
  }
  return table;
}

/**
 * Expected Calibration Error + reliability table. ECE bins predictions by
 * confidence and takes the count-weighted mean gap between each bin's predicted
 * mean and its empirical correct-rate:
 *
 *   ECE = Σ_b (n_b / N) · |conf_b − acc_b|
 *
 * Empty bins contribute nothing. Returns the full reliability table so callers
 * (the eval gate) can read the confidence at which empirical precision crosses
 * the trust bar and set the #33 floor / #70 ceiling from it.
 */
export function expectedCalibrationError(
  pairs: readonly CalibrationPair[],
  bins: number = DEFAULT_BINS,
): CalibrationReport {
  const reliability = buildReliability(pairs, bins);
  const total = pairs.length;
  let ece = 0;
  if (total > 0) {
    for (const bin of reliability) {
      if (bin.count === 0) continue;
      ece += (bin.count / total) * Math.abs(bin.predictedMean - bin.empiricalRate);
    }
  }
  return { ece, total, reliability };
}

/**
 * Brier score: mean squared error between confidence and the binary outcome.
 *
 *   Brier = (1/N) · Σ_i (conf_i − y_i)²,  y_i ∈ {0, 1}
 *
 * Lower is better; 0 is perfect, 0.25 is a constant 0.5 guess. Empty input -> 0.
 */
export function brierScore(pairs: readonly CalibrationPair[]): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const { confidence, correct } of pairs) {
    if (confidence < 0 || confidence > 1 || !Number.isFinite(confidence)) {
      throw new Error(`confidence ${confidence} out of range [0, 1]`);
    }
    const e = confidence - asOutcome(correct);
    sum += e * e;
  }
  return sum / pairs.length;
}

/** Seeded PRNG, identical to the #46/#84 bootstrap in metrics.ts (mulberry32). */

export interface EceCI {
  ece: number;
  lower: number;
  upper: number;
}

export interface BootstrapOptions {
  iterations?: number;
  /** Two-sided alpha (default 0.05 -> 95% CI). */
  alpha?: number;
  seed?: number;
}

/**
 * Seeded bootstrap percentile CI on ECE, resampling pairs with replacement.
 * Deterministic (mulberry32, #46) so the eval gate (#48/#71) reproduces it.
 */
export function bootstrapEceCI(
  pairs: readonly CalibrationPair[],
  bins: number = DEFAULT_BINS,
  options: BootstrapOptions = {},
): EceCI {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = mulberry32(options.seed ?? 1);
  const n = pairs.length;
  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const resampled: CalibrationPair[] = [];
    for (let i = 0; i < n; i++) resampled.push(pairs[Math.floor(rng() * n)] as CalibrationPair);
    const value = expectedCalibrationError(resampled, bins).ece;
    if (Number.isFinite(value)) samples.push(value);
  }
  samples.sort((x, y) => x - y);
  const at = (q: number): number =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))] ?? 0;
  return { ece: expectedCalibrationError(pairs, bins).ece, lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}

/** A monotonic non-decreasing calibration map: raw confidence -> calibrated probability. */
export type CalibrationMap = (raw: number) => number;

export interface CalibrationKnotV1 {
  raw: number;
  calibrated: number;
}

/** Serializable replacement for the old closure-only isotonic map. */
export interface CalibrationTransformV1 {
  kind: "isotonic_v1";
  knots: CalibrationKnotV1[];
}

/**
 * Fit a post-hoc monotonic calibration map via **isotonic regression** (the
 * Pool Adjacent Violators Algorithm, PAVA). The empirical correct-rate is a
 * non-decreasing step function of confidence; for a raw value we interpolate
 * linearly between the fitted step points (and clamp at the ends), turning the
 * saturated verbalized score into a real probability before the #33 floor.
 *
 * The map is the IDENTITY when it cannot be fit (no pairs, or every confidence
 * identical, since there is nothing to learn a slope from). The returned function
 * always clamps its output to [0, 1].
 *
 * Pure / deterministic: same pairs -> same map. Adoption is eval-gated (#48/#71);
 * the offline golden-set run that produces the pairs is the live seam.
 */
export function fitSerializableMonotonicCalibration(
  pairs: readonly CalibrationPair[],
): CalibrationTransformV1 {
  const identity: CalibrationTransformV1 = {
    kind: "isotonic_v1",
    knots: [
      { raw: 0, calibrated: 0 },
      { raw: 1, calibrated: 1 },
    ],
  };
  if (pairs.length === 0) return identity;

  // Sort by confidence; break ties on outcome so equal-x points pool stably.
  const sorted = [...pairs].sort((p, q) => p.confidence - q.confidence || asOutcome(p.correct) - asOutcome(q.correct));
  if ((sorted[sorted.length - 1] as CalibrationPair).confidence === (sorted[0] as CalibrationPair).confidence) {
    return identity; // all confidences identical -> no monotonic signal
  }

  // PAVA starts from one weighted block per DISTINCT confidence. Real judge
  // outputs are heavily quantized (many 0.9/0.95 values); leaving ties as
  // separate points would serialize duplicate raw knots, which are ambiguous to
  // reconstruct and rejected by CalibrationReportV1 validation.
  interface Block {
    x: number; // weighted-mean confidence
    y: number; // weighted-mean outcome (the fitted calibrated value)
    w: number;
  }
  const grouped: Block[] = [];
  for (const p of sorted) {
    const last = grouped[grouped.length - 1];
    if (last?.x === p.confidence) {
      const w = last.w + 1;
      last.y = (last.y * last.w + asOutcome(p.correct)) / w;
      last.w = w;
    } else {
      grouped.push({ x: p.confidence, y: asOutcome(p.correct), w: 1 });
    }
  }

  // Merge adjacent blocks while the sequence of weighted outcome means falls.
  const blocks: Block[] = [];
  for (const initial of grouped) {
    let block: Block = { ...initial };
    while (blocks.length > 0 && (blocks[blocks.length - 1] as Block).y > block.y) {
      const prev = blocks.pop() as Block;
      const w = prev.w + block.w;
      block = {
        x: (prev.x * prev.w + block.x * block.w) / w,
        y: (prev.y * prev.w + block.y * block.w) / w,
        w,
      };
    }
    blocks.push(block);
  }

  const knots = blocks.map((block) => ({ raw: block.x, calibrated: block.y }));
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (first && first.raw > 0) knots.unshift({ raw: 0, calibrated: first.calibrated });
  if (last && last.raw < 1) knots.push({ raw: 1, calibrated: last.calibrated });
  return { kind: "isotonic_v1", knots };
}

/** Reconstruct and apply the exact serialized piecewise-linear map. */
export function applyCalibrationTransform(transform: CalibrationTransformV1, raw: number): number {
  if (!Number.isFinite(raw)) throw new Error("raw confidence must be finite");
  const knots = transform.knots;
  if (transform.kind !== "isotonic_v1" || knots.length < 2) {
    throw new Error("invalid calibration transform");
  }
  const x = Math.min(1, Math.max(0, raw));
  const first = knots[0] as CalibrationKnotV1;
  const last = knots[knots.length - 1] as CalibrationKnotV1;
  if (x <= first.raw) return Math.min(1, Math.max(0, first.calibrated));
  if (x >= last.raw) return Math.min(1, Math.max(0, last.calibrated));

  let i = 0;
  while (i < knots.length - 1 && (knots[i + 1] as CalibrationKnotV1).raw < x) i++;
  const left = knots[i] as CalibrationKnotV1;
  const right = knots[i + 1] as CalibrationKnotV1;
  const t = right.raw === left.raw ? 0 : (x - left.raw) / (right.raw - left.raw);
  return Math.min(1, Math.max(0, left.calibrated + t * (right.calibrated - left.calibrated)));
}

export function fitMonotonicCalibration(pairs: readonly CalibrationPair[]): CalibrationMap {
  const transform = fitSerializableMonotonicCalibration(pairs);

  return (raw: number) => applyCalibrationTransform(transform, raw);
}

/** Apply a calibration map to a confidence (convenience; identical to calling the map). */
export function applyCalibration(map: CalibrationMap, raw: number): number {
  return map(raw);
}
