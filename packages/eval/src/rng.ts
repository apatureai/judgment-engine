/**
 * The eval package's seeded PRNG.
 *
 * `mulberry32` was copy-pasted, byte-identical, into calibration.ts and
 * metrics.ts. A seeded RNG is exactly the thing that must NOT drift between
 * copies: eval reproducibility depends on the same seed always producing the
 * same stream, so it lives in one place.
 */

/**
 * Deterministic mulberry32 PRNG: a seed yields a function returning the next
 * float in [0, 1). The same seed always produces the same stream, the basis of
 * reproducible eval sampling.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
