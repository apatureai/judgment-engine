/**
 * Capture stability gate (TRD §4.1/§5; architecture review E4). Two shots taken
 * a short interval apart are compared by BOTH a perceptual hash (phash) and an
 * orthogonal structural-diff hash — the structural hash catches layout
 * instability the phash misses. Up to `maxAttempts` shots are taken; the page is
 * declared stable as soon as a consecutive pair matches within threshold.
 *
 * Known-animated regions (video, [data-carousel], geometry-flagged elements from
 * #18) must be excluded by the sampler BEFORE hashing, so one carousel doesn't
 * spuriously cap confidence. On persistent instability the page is captured
 * anyway and a confidence ceiling is emitted for the critique (#70).
 *
 * Pure logic with an injected sampler — the hashing + pixel masking are the
 * worker seam; this is fully testable without a browser or image library.
 */

/** Confidence ceiling applied to findings when the page never settled. */
export const UNSTABLE_CONFIDENCE_CEILING = 0.6;

export interface StabilityOptions {
  /** Max shots to take (default 3). */
  maxAttempts?: number;
  /** Max phash hamming distance to count as unchanged (default 5). */
  phashThreshold?: number;
  /** Max structural-hash hamming distance to count as unchanged (default 0). */
  structuralThreshold?: number;
}

export interface StabilitySample {
  phash: string;
  structuralHash: string;
}

export interface StabilityResult {
  stable: boolean;
  /** Number of shots actually taken. */
  attempts: number;
  /** Confidence ceiling to apply when unstable; null when stable. */
  confidenceCeiling: number | null;
  /** The sample to hand to critique (the last shot taken). */
  sample: StabilitySample;
}

function popcountNibble(x: number): number {
  return (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
}

/** Hamming distance between two equal-length hex hash strings. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error("hash lengths differ");
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16);
    dist += popcountNibble(x);
  }
  return dist;
}

/** Whether two hashes are within `threshold` hamming distance. */
export function hashesWithin(a: string, b: string, threshold: number): boolean {
  return hammingDistance(a, b) <= threshold;
}

function samplesMatch(a: StabilitySample, b: StabilitySample, opts: Required<StabilityOptions>): boolean {
  return (
    hashesWithin(a.phash, b.phash, opts.phashThreshold) &&
    hashesWithin(a.structuralHash, b.structuralHash, opts.structuralThreshold)
  );
}

/**
 * Run the stability gate: take shots via `capture(attempt)` (0-based) and stop
 * as soon as a consecutive pair matches. On persistent instability returns the
 * last shot with the unstable confidence ceiling set.
 */
export async function runStabilityGate(
  capture: (attempt: number) => Promise<StabilitySample>,
  options: StabilityOptions = {},
): Promise<StabilityResult> {
  const opts: Required<StabilityOptions> = {
    maxAttempts: options.maxAttempts ?? 3,
    phashThreshold: options.phashThreshold ?? 5,
    structuralThreshold: options.structuralThreshold ?? 0,
  };
  if (opts.maxAttempts < 2) throw new Error("maxAttempts must be >= 2 to compare shots");

  let prev = await capture(0);
  for (let attempt = 1; attempt < opts.maxAttempts; attempt++) {
    const next = await capture(attempt);
    if (samplesMatch(prev, next, opts)) {
      return { stable: true, attempts: attempt + 1, confidenceCeiling: null, sample: next };
    }
    prev = next;
  }
  return {
    stable: false,
    attempts: opts.maxAttempts,
    confidenceCeiling: UNSTABLE_CONFIDENCE_CEILING,
    sample: prev,
  };
}
