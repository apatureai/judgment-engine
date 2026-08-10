/**
 * Cross-language golden contract for the Rust capture-dedup spike
 * (`rust/capture-dedup`). dhash is pure integer math, so a minimal TypeScript
 * mirror must produce bit-identical u64 hashes for the shared golden vectors,
 * the same contract style the Python dataset mirror uses (#127/#130). If this
 * test and `cargo test` disagree, one implementation drifted.
 *
 * Only dhash is mirrored: phash intentionally stays Rust-reference-only (its
 * float DCT is quantized for determinism, but re-implementing it here would
 * just duplicate the reference without adding contract value).
 *
 * The `pairs` section carries Rust-computed ssim/diff_ratio tile scores. Those
 * are float math, so they are NOT re-derived here; instead they are fed
 * through the change-detection decision seam (`detectBaselineChange`) to
 * cross-validate the producer/consumer contract end to end: Rust scores for
 * identical images must decide "confirmed unchanged", scores for structurally
 * different images must decide "changed", even when pHash matches (the exact
 * blindness the seam exists to catch).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectBaselineChange } from "../src/change-detection.js";

interface GoldenVector {
  name: string;
  kind: string;
  w: number;
  h: number;
  param: number;
  dhash: string;
  phash: string;
}

interface GoldenPair {
  a: string;
  b: string;
  threshold: number;
  ssim: number;
  diff_ratio: number;
}

const goldenPath = fileURLToPath(
  new URL("../../../rust/capture-dedup/golden/vectors.json", import.meta.url),
);
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
  vectors: GoldenVector[];
  pairs: GoldenPair[];
};
const vectors = golden.vectors;
const pairs = golden.pairs;

/** Mirrors the Rust generators byte-for-byte (integer math only). */
function generate(kind: string, w: number, h: number, param: number): Uint8Array {
  const px = new Uint8Array(w * h);
  let i = 0;
  if (kind === "gradient-h") {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) px[i++] = Math.floor((Math.min(x + param, w - 1) * 255) / (w - 1));
  } else if (kind === "gradient-v") {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[i++] = Math.floor((y * 255) / (h - 1));
  } else if (kind === "inverted-gradient-h") {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) px[i++] = 255 - Math.floor((x * 255) / (w - 1));
  } else if (kind === "checkerboard") {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        px[i++] = (Math.floor(x / param) + Math.floor(y / param)) % 2 === 0 ? 0 : 255;
  } else if (kind === "lcg-noise") {
    // 32-bit LCG (numerical recipes); pixel = top byte of the state.
    let s = param >>> 0;
    for (let k = 0; k < w * h; k++) {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      px[k] = s >>> 24;
    }
  } else {
    throw new Error(`unknown generator kind: ${kind}`);
  }
  return px;
}

/** Half-open pixel range of destination cell i (mirrors Rust cell_bounds). */
function cellBounds(i: number, src: number, dst: number): [number, number] {
  const start = Math.floor((i * src) / dst);
  const end = Math.floor(((i + 1) * src) / dst);
  return end <= start ? [start, start + 1] : [start, end];
}

/** dhash mirror: 9x8 box-filtered grid, horizontal neighbour compare, BigInt u64. */
function dhash(gray: Uint8Array, w: number, h: number): bigint {
  const grid: number[][] = [];
  for (let row = 0; row < 8; row++) {
    const [y0, y1] = cellBounds(row, h, 8);
    const cells: number[] = [];
    for (let col = 0; col < 9; col++) {
      const [x0, x1] = cellBounds(col, w, 9);
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * w + x] as number;
      cells.push(Math.floor(sum / ((y1 - y0) * (x1 - x0))));
    }
    grid.push(cells);
  }
  let hash = 0n;
  for (const row of grid)
    for (let col = 0; col < 8; col++) {
      hash <<= 1n;
      if ((row[col] as number) < (row[col + 1] as number)) hash |= 1n;
    }
  return hash;
}

describe("capture-dedup cross-language golden contract", () => {
  it("ships the expected golden vector set", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of vectors) expect(v.dhash).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each(vectors.map((v) => [v.name, v] as const))(
    "TS dhash mirror matches the Rust golden hash for %s",
    (_name, v) => {
      const px = generate(v.kind, v.w, v.h, v.param);
      expect(dhash(px, v.w, v.h).toString(16).padStart(16, "0")).toBe(v.dhash);
    },
  );
});

describe("Rust tile scores drive the change-detection decision seam", () => {
  // Both hashes equal ⇒ pHash matches ⇒ the decision rests entirely on the
  // tile scores, which is exactly the confirm path these kernels exist for.
  const phashMatch = { baselinePhash: "00", currentPhash: "00" };
  const pairFor = (a: string, b: string): GoldenPair => {
    const p = pairs.find((p) => p.a === a && p.b === b);
    if (!p) throw new Error(`golden pair missing: ${a} vs ${b}`);
    return p;
  };

  it("ships identical and structurally-different golden pairs", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(4);
    for (const p of pairs) {
      expect(p.ssim).toBeGreaterThanOrEqual(0);
      expect(p.ssim).toBeLessThanOrEqual(1);
      expect(p.diff_ratio).toBeGreaterThanOrEqual(0);
      expect(p.diff_ratio).toBeLessThanOrEqual(1);
    }
  });

  it.each(pairs.filter((p) => p.a === p.b).map((p) => [p.a, p] as const))(
    "identical-pair scores confirm unchanged (%s)",
    (_name, p) => {
      for (const tile of [{ ssim: p.ssim }, { diffRatio: p.diff_ratio }]) {
        expect(detectBaselineChange({ ...phashMatch, tileScores: [tile] })).toEqual({
          changed: false,
          reason: "confirmed_unchanged",
        });
      }
    },
  );

  it("near-duplicate scores (1px gradient shift) confirm unchanged", () => {
    const p = pairFor("gradient-h-64x48", "gradient-h-64x48-shift1");
    expect(
      detectBaselineChange({ ...phashMatch, tileScores: [{ ssim: p.ssim }] }),
    ).toEqual({ changed: false, reason: "confirmed_unchanged" });
  });

  it.each(
    pairs
      .filter((p) => p.a !== p.b && p.b !== "gradient-h-64x48-shift1")
      .map((p) => [`${p.a} vs ${p.b}`, p] as const),
  )("structurally-different scores decide changed despite a pHash match (%s)", (_name, p) => {
    for (const tile of [{ ssim: p.ssim }, { diffRatio: p.diff_ratio }]) {
      expect(detectBaselineChange({ ...phashMatch, tileScores: [tile] })).toEqual({
        changed: true,
        reason: "tile_changed",
      });
    }
  });
});
