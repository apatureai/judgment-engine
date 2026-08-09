# capture-dedup (Rust spike)

Perceptual near-duplicate detection for capture screenshots: retries, reruns, and
superseded pushes produce pixel-different but perceptually identical frames, and every
duplicate that reaches the judge burns VLM tokens — the dominant cost of a review. This crate hashes
frames so the capture pipeline can skip near-duplicates of already-judged screenshots.

A language spike against the standing rule: *"Rust/WASM
deferred until a measured hotspot."* This is the measurement.

## What's here

- `dhash` — 9×8 box-filtered difference hash. **Pure integer math, bit-exact across
  platforms and languages**; this is the cross-language contract
  (`golden/vectors.json`, mirrored byte-for-byte by
  `packages/capture/test/dedup-golden.test.ts`).
- `phash` — 32×32 box downscale → orthonormal 2D DCT-II → 8×8 low-frequency block →
  ×64-quantized median threshold. Rust-reference-only (float DCT). The ×64 scale keeps
  6 fractional bits so low-amplitude structure in flat, screenshot-like content
  survives quantization (whole-integer rounding collapsed smooth pages toward all-zero
  hashes → false near-dup matches). Known, pinned caveat: analytically-sparse
  synthetic images (pure gradients, exact checkerboards) still hash near zero — that
  is inherent to median-threshold DCT hashing; structured-flat separation is dhash's
  job, and the tests assert exactly that split.
- `hamming` / `is_near_duplicate` — Hamming distance is a metric (test-verified);
  threshold ≈ 10 works for dhash near-dup detection.
- `ssim` / `diff_ratio` / `tile_score` *(added July 9, 2026)* — the change-sensitive
  confirm kernels behind the `packages/capture/src/change-detection.ts` decision seam:
  8×8-window stride-4 SSIM (Wang et al. 2004, integer moments, bit-stable f64) and a
  grayscale port of pixelmatch's anti-aliasing-aware pixel diff. The golden file's
  `pairs` section carries Rust-computed scores; the TS golden test feeds them through
  `detectBaselineChange` end to end (identical ⇒ `confirmed_unchanged`, structurally
  different ⇒ `tile_changed` even when pHash matches — the exact blindness the seam
  exists to catch).
- Deterministic by construction: no RNG, clocks, I/O, deps, or `unsafe`
  (`#![forbid(unsafe_code)]`).

Regenerate goldens after any algorithm change:
`cargo run --example gen_golden > golden/vectors.json` (the sync test fails if stale).

## The measurement (Apple M-series, release build, 1920×1080 grayscale, 100 runs)

| implementation | ns/op | ms/frame |
| --- | --- | --- |
| Rust `dhash` | 158,770 | 0.16 |
| Rust `phash` | 699,124 | 0.70 |
| Node `dhash` (same algorithm, `bench/bench-ts.mjs`) | 1,487,219 | 1.49 |

Rust is **~9.4× faster** on the contract hash.

## Verdict against the revisit gate

**Not a hotspot. The deferral stands.** At an aggressive 10,000 reviews/day ×
12 screenshots = 120k frames/day:

- TypeScript dhash: 120k × 1.49 ms ≈ **179 CPU-seconds/day**
- Rust dhash: 120k × 0.16 ms ≈ 19 CPU-seconds/day

A 9.4× speedup buys back under three CPU-minutes per day at a scale far beyond
current volume — noise next to a single VLM call. The correct production move today
is a ~60-line TS `dhash` (the golden-test mirror is exactly that) inside the capture
pipeline, with this crate kept as the pinned cross-language reference.

**When to flip:** if the capture pipeline ever grows real per-pixel compute — SSIM /
full-page perceptual diffing, region proposals, or per-frame work at video rates —
this crate is the seed. Integration path, in order of preference:

1. **wasm-pack** (`wasm32-unknown-unknown`): no native-addon build matrix, runs in the
   same Node process, deterministic; expect ~2-4× over JS (still ahead of the 9.4×
   native ceiling only for heavier kernels).
2. **napi-rs** if a profiled kernel needs the full native speed and SIMD.

## The flip clause, measured (July 9, 2026)

The clause above fired: the change-detection seam's score producers (per-tile SSIM +
AA-aware pixel diff — real per-pixel compute on the recheck path) were implemented
nowhere, so both kernels were built here and a faithful TS port (validated to 12
fractional digits against the golden pair scores) was benchmarked head-to-head.
Same machine, same frames, same algorithm:

| kernel (1920×1080) | Rust ms/frame | Node ms/frame | speedup |
| --- | --- | --- | --- |
| `ssim` | 6.13 | 16.80 | 2.7× |
| `diff_ratio`, near-identical pair (the realistic confirm path) | 0.90 | 4.49 | 5.0× |
| `diff_ratio`, unrelated-noise worst case | 115.13 | 224.78 | 2.0× |

**Verdict: the deferral still stands — the numbers came back smaller than the 9.4×
hash gap suggested.** V8 on `Uint8Array` handles these integer loops well. The
confirm kernels only run on pHash-*match* candidates (a mismatch short-circuits to
"changed" before any tile is scored), so the realistic cost is the near-identical
row: ~21 ms/frame in TS vs ~7 ms in Rust. At the same aggressive 120k frames/day,
Rust buys back ~28 CPU-minutes/day — still noise next to one VLM call, and
irrelevant to latency (the deep review it gates costs seconds). The production
move remains a TS port in the capture worker, pinned against this crate's golden
pair scores exactly like dhash. If volume ever makes those CPU-minutes matter,
integrate via **wasm-pack** first (the 2-2.7× kernel gap is mostly recoverable in
wasm without a native build matrix); reach for **napi-rs** only if profiling then
demands the last ~30%.

## Validation

`cargo test` (20 tests: golden sync + cross-checks, metric properties via LCG
sampling, near-dup/separation behavior, SSIM/diff-ratio identity/symmetry/range,
AA-shift exclusion, panics on bad dims) · `cargo clippy --all-targets` clean ·
`cargo fmt --check` clean · TS mirror + decision-seam cross-validation:
`pnpm exec vitest run packages/capture/test/dedup-golden.test.ts` (14 tests) · a
separate `rust · capture-dedup` CI job runs `cargo test` without touching the
existing TS/Python jobs.
