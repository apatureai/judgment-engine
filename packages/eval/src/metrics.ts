import type { Dimension, Grade } from "@engine/types";
import { findingKey, type LabeledFinding } from "./golden-set.js";

/**
 * Eval metrics suite (TRD §10, #46). Per-dimension precision/recall over the
 * golden set, the headline **blocker recall** (did we catch the serious ones?)
 * and the trust metric **nit precision** (are our nits real?), plus
 * **quadratic-weighted kappa** with bootstrapped CIs for inter-rater / model-vs-
 * human grade agreement. Pure stats — no model calls.
 */
export interface PrecisionRecall {
  precision: number;
  recall: number;
  tp: number;
  fp: number;
  fn: number;
}

function prFromCounts(tp: number, fp: number, fn: number): PrecisionRecall {
  return {
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    tp,
    fp,
    fn,
  };
}

/** Detection precision/recall by matching findings on dimension+route+elementRef. */
export function precisionRecall(predicted: LabeledFinding[], truth: LabeledFinding[]): PrecisionRecall {
  const predKeys = new Set(predicted.map(findingKey));
  const truthKeys = new Set(truth.map(findingKey));
  let tp = 0;
  for (const k of predKeys) if (truthKeys.has(k)) tp++;
  return prFromCounts(tp, predKeys.size - tp, truthKeys.size - tp);
}

/** Precision/recall per rubric dimension. */
export function perDimensionPR(
  predicted: LabeledFinding[],
  truth: LabeledFinding[],
): Partial<Record<Dimension, PrecisionRecall>> {
  const dims = new Set<Dimension>([...predicted, ...truth].map((f) => f.dimension));
  const out: Partial<Record<Dimension, PrecisionRecall>> = {};
  for (const dim of dims) {
    out[dim] = precisionRecall(
      predicted.filter((f) => f.dimension === dim),
      truth.filter((f) => f.dimension === dim),
    );
  }
  return out;
}

/** Headline metric: recall over ground-truth blocker findings. */
export function blockerRecall(predicted: LabeledFinding[], truth: LabeledFinding[]): number {
  const blockers = truth.filter((f) => f.severity === "blocker");
  if (blockers.length === 0) return 1; // vacuous
  const predKeys = new Set(predicted.map(findingKey));
  const caught = blockers.filter((f) => predKeys.has(findingKey(f))).length;
  return caught / blockers.length;
}

/** Trust metric: precision over predicted nit findings (are our nits real?). */
export function nitPrecision(predicted: LabeledFinding[], truth: LabeledFinding[]): number {
  const nits = predicted.filter((f) => f.severity === "nit");
  if (nits.length === 0) return 1; // vacuously precise
  const truthKeys = new Set(truth.map(findingKey));
  return nits.filter((f) => truthKeys.has(findingKey(f))).length / nits.length;
}

export const GRADE_SCALE: Grade[] = ["ship", "ship_with_nits", "needs_work", "blocked"];

/** Quadratic-weighted Cohen's kappa over the 4-level ordinal grade scale. */
export function quadraticWeightedKappa(a: Grade[], b: Grade[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error("kappa needs equal, non-empty grade arrays");
  const k = GRADE_SCALE.length;
  const idx = (g: Grade): number => GRADE_SCALE.indexOf(g);

  const observed: number[][] = Array.from({ length: k }, () => Array<number>(k).fill(0));
  const rowMarg = Array<number>(k).fill(0);
  const colMarg = Array<number>(k).fill(0);
  for (let n = 0; n < a.length; n++) {
    const i = idx(a[n] as Grade);
    const j = idx(b[n] as Grade);
    const row = observed[i] as number[];
    row[j] = (row[j] ?? 0) + 1;
    rowMarg[i] = (rowMarg[i] ?? 0) + 1;
    colMarg[j] = (colMarg[j] ?? 0) + 1;
  }

  const total = a.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = ((i - j) * (i - j)) / ((k - 1) * (k - 1));
      const expected = ((rowMarg[i] ?? 0) * (colMarg[j] ?? 0)) / total;
      numerator += w * ((observed[i] as number[])[j] ?? 0);
      denominator += w * expected;
    }
  }
  if (denominator === 0) return 1; // no expected disagreement -> perfect by convention
  return 1 - numerator / denominator;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KappaCI {
  kappa: number;
  lower: number;
  upper: number;
}

export interface BootstrapOptions {
  iterations?: number;
  /** Two-sided alpha (default 0.05 -> 95% CI). */
  alpha?: number;
  seed?: number;
}

/** Quadratic-weighted kappa with a bootstrapped percentile CI (seeded, deterministic). */
export function bootstrapKappaCI(a: Grade[], b: Grade[], options: BootstrapOptions = {}): KappaCI {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = mulberry32(options.seed ?? 1);
  const n = a.length;

  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const ra: Grade[] = [];
    const rb: Grade[] = [];
    for (let i = 0; i < n; i++) {
      const pick = Math.floor(rng() * n);
      ra.push(a[pick] as Grade);
      rb.push(b[pick] as Grade);
    }
    const value = quadraticWeightedKappa(ra, rb);
    if (Number.isFinite(value)) samples.push(value);
  }
  samples.sort((x, y) => x - y);
  const at = (q: number): number => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))] ?? 0;
  return { kappa: quadraticWeightedKappa(a, b), lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}
