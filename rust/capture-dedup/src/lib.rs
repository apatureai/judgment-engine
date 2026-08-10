//! Perceptual near-duplicate detection for capture screenshots.
//!
//! Retries, reruns, and superseded pushes produce screenshots that are pixel-different
//! but perceptually identical. Every duplicate that reaches the judge burns VLM tokens
//! (the COGS center), so the capture pipeline hashes each screenshot and skips frames
//! that are near-duplicates of one already judged for the same `(pr, head_sha, route)`.
//!
//! Two 64-bit hashes are provided:
//!
//! - [`dhash`]: difference hash over a 9x8 box-filtered grid. Pure integer math, so
//!   the value is bit-exact across platforms and languages; it is the cross-language
//!   golden contract (see `golden/vectors.json` and the mirror TypeScript
//!   implementation in `packages/capture/test/dedup-golden.test.ts`).
//! - [`phash`]: DCT hash. 32x32 box-filter downscale, 2D DCT-II, median threshold on
//!   the 8x8 low-frequency block. Coefficients are scaled by 64 and rounded (6
//!   fractional bits) before the median compare so that sub-ulp differences between
//!   platform `cos` implementations cannot flip bits while low-amplitude structure
//!   in flat screenshot-like images still survives quantization.
//!
//! The library is deterministic by construction: no RNG, no clocks, no I/O, no unsafe.

#![forbid(unsafe_code)]

/// Half-open pixel range `[start, end)` of destination cell `i` when downscaling a
/// source axis of length `src` to `dst` cells. When `src < dst`, cells reuse the
/// nearest source pixel so every cell is non-empty.
fn cell_bounds(i: usize, src: usize, dst: usize) -> (usize, usize) {
    let start = i * src / dst;
    let end = (i + 1) * src / dst;
    if end <= start {
        (start, start + 1)
    } else {
        (start, end)
    }
}

fn assert_dims(gray: &[u8], w: usize, h: usize) {
    assert!(w > 0 && h > 0, "image dimensions must be non-zero");
    assert_eq!(gray.len(), w * h, "gray buffer length must equal w * h");
}

/// Difference hash of a grayscale image (row-major, one byte per pixel).
///
/// The image is box-filtered down to a 9-wide by 8-tall grid of floor-averaged
/// luminance values. Each of the 64 bits compares horizontal neighbours: scanning
/// rows top-to-bottom and columns left-to-right, the hash is shifted left one bit
/// and the low bit is set when `cell[row][col] < cell[row][col + 1]`.
///
/// Integer math only, so the result is bit-exact across platforms and languages.
///
/// # Panics
/// Panics if `w == 0`, `h == 0`, or `gray.len() != w * h`.
pub fn dhash(gray: &[u8], w: usize, h: usize) -> u64 {
    assert_dims(gray, w, h);
    let mut grid = [[0u64; 9]; 8];
    for (row, grid_row) in grid.iter_mut().enumerate() {
        let (y0, y1) = cell_bounds(row, h, 8);
        for (col, cell) in grid_row.iter_mut().enumerate() {
            let (x0, x1) = cell_bounds(col, w, 9);
            let mut sum: u64 = 0;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += u64::from(gray[y * w + x]);
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            *cell = sum / count;
        }
    }
    let mut hash = 0u64;
    for row in &grid {
        for col in 0..8 {
            hash <<= 1;
            if row[col] < row[col + 1] {
                hash |= 1;
            }
        }
    }
    hash
}

const PHASH_SIZE: usize = 32;
const PHASH_BLOCK: usize = 8;

/// DCT perceptual hash of a grayscale image (row-major, one byte per pixel).
///
/// The image is box-filtered down to 32x32 mean luminance values, transformed with an
/// orthonormal 2D DCT-II, and the 8x8 low-frequency block (including DC) is kept.
/// Each coefficient is scaled by 64 and rounded to the nearest integer; this
/// quantization makes the hash immune to last-ulp differences between platform
/// `cos`/floating-point implementations (analytically-zero coefficients of symmetric
/// images land on exact 0 instead of ±1e-13 noise) while keeping 6 fractional bits so
/// low-amplitude structure in flat screenshot-like content survives. Bits are emitted
/// row-major over the block, shifting left and setting the low bit when the quantized
/// coefficient exceeds the lower median of all 64 quantized coefficients.
///
/// # Panics
/// Panics if `w == 0`, `h == 0`, or `gray.len() != w * h`.
pub fn phash(gray: &[u8], w: usize, h: usize) -> u64 {
    assert_dims(gray, w, h);

    // 32x32 box-filter downscale to mean luminance (f64).
    let mut img = [[0f64; PHASH_SIZE]; PHASH_SIZE];
    for (row, img_row) in img.iter_mut().enumerate() {
        let (y0, y1) = cell_bounds(row, h, PHASH_SIZE);
        for (col, px) in img_row.iter_mut().enumerate() {
            let (x0, x1) = cell_bounds(col, w, PHASH_SIZE);
            let mut sum: u64 = 0;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += u64::from(gray[y * w + x]);
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as f64;
            *px = sum as f64 / count;
        }
    }

    // Orthonormal DCT-II basis for the first PHASH_BLOCK frequencies of a
    // PHASH_SIZE-point axis: basis[u][x] = c(u) * cos((2x + 1) * u * pi / (2 * N)).
    let n = PHASH_SIZE as f64;
    let mut basis = [[0f64; PHASH_SIZE]; PHASH_BLOCK];
    for (u, basis_u) in basis.iter_mut().enumerate() {
        let scale = if u == 0 {
            (1.0 / n).sqrt()
        } else {
            (2.0 / n).sqrt()
        };
        for (x, b) in basis_u.iter_mut().enumerate() {
            *b = scale
                * ((2.0 * x as f64 + 1.0) * u as f64 * std::f64::consts::PI / (2.0 * n)).cos();
        }
    }

    // Separable 2D DCT-II, keeping only the PHASH_BLOCK x PHASH_BLOCK output block.
    let mut rows = [[0f64; PHASH_BLOCK]; PHASH_SIZE];
    for y in 0..PHASH_SIZE {
        for u in 0..PHASH_BLOCK {
            let mut acc = 0.0;
            for x in 0..PHASH_SIZE {
                acc += img[y][x] * basis[u][x];
            }
            rows[y][u] = acc;
        }
    }
    let mut quantized = [0i64; PHASH_BLOCK * PHASH_BLOCK];
    for v in 0..PHASH_BLOCK {
        for u in 0..PHASH_BLOCK {
            let mut acc = 0.0;
            for y in 0..PHASH_SIZE {
                acc += rows[y][u] * basis[v][y];
            }
            // Scale by 64 (6 fractional bits) before rounding: platform cos/fma noise
            // is ~1e-13 (~1e-11 after scaling, far below the 0.5 rounding threshold),
            // but real low-amplitude structure in flat screenshot-like images lives in
            // coefficients well under 1.0 and must survive quantization, or every
            // smooth page collapses to a near-zero hash and false near-dup matches.
            quantized[v * PHASH_BLOCK + u] = (acc * 64.0).round() as i64;
        }
    }

    let mut sorted = quantized;
    sorted.sort_unstable();
    let median = sorted[PHASH_BLOCK * PHASH_BLOCK / 2 - 1]; // lower median of 64 values

    let mut hash = 0u64;
    for q in &quantized {
        hash <<= 1;
        if *q > median {
            hash |= 1;
        }
    }
    hash
}

// --- change-sensitive tile scores (the capture-worker side of the
// packages/capture/src/change-detection.ts decision seam) ---
//
// The pure TS seam consumes per-tile `ssim` / `diffRatio` scores in [0, 1] to
// CONFIRM a pHash match before short-circuiting the deep review; these kernels
// are the producer of those scores. Hashes stay the cheap pre-filter; SSIM and
// the AA-aware pixel diff are the expensive, change-sensitive confirmation.

const SSIM_WINDOW: usize = 8;
const SSIM_STRIDE: usize = 4;
// Standard SSIM stabilizers: C1 = (k1*L)^2, C2 = (k2*L)^2 with k1 = 0.01,
// k2 = 0.03, L = 255.
const SSIM_C1: f64 = 6.5025;
const SSIM_C2: f64 = 58.5225;

/// Window start offsets along one axis: every `stride` positions, plus a final
/// end-aligned window so the trailing pixels are always covered. A single
/// full-axis window when the axis is shorter than `win`.
fn window_starts(len: usize, win: usize, stride: usize) -> Vec<usize> {
    if len <= win {
        return vec![0];
    }
    let mut starts: Vec<usize> = (0..=len - win).step_by(stride).collect();
    if *starts.last().expect("non-empty by construction") != len - win {
        starts.push(len - win);
    }
    starts
}

/// Mean structural similarity (SSIM) of two grayscale images (row-major, one
/// byte per pixel), in `[0, 1]`; `1.0` means identical.
///
/// Standard SSIM (Wang et al. 2004) over an 8x8 sliding window with stride 4
/// (stride > 1 trades the canonical dense/Gaussian window for a 16x cheaper
/// scan; on screenshot content the per-window scores vary slowly, so the mean
/// is stable) using `k1 = 0.01`, `k2 = 0.03`, `L = 255` and uniform (box)
/// window weighting. Windows are end-aligned at the right/bottom edges so
/// every pixel is covered; images smaller than the window use one full-image
/// window.
///
/// Deterministic: per-window moments are exact integer sums; the closed-form
/// SSIM expression is a fixed sequence of IEEE-754 f64 ops, so results are
/// bit-identical across platforms. The mean is clamped at 0 (per-window SSIM
/// can be marginally negative on anticorrelated content; the TileChangeScore
/// contract is `[0, 1]`).
///
/// # Panics
/// Panics if `w == 0`, `h == 0`, or either buffer's length is not `w * h`.
pub fn ssim(a: &[u8], b: &[u8], w: usize, h: usize) -> f64 {
    assert_dims(a, w, h);
    assert_dims(b, w, h);
    let ys = window_starts(h, SSIM_WINDOW, SSIM_STRIDE);
    let xs = window_starts(w, SSIM_WINDOW, SSIM_STRIDE);
    let wh = SSIM_WINDOW.min(h);
    let ww = SSIM_WINDOW.min(w);
    let n = (wh * ww) as f64;
    let mut total = 0.0;
    for &y0 in &ys {
        for &x0 in &xs {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for y in y0..y0 + wh {
                let row = y * w;
                for x in x0..x0 + ww {
                    let pa = u64::from(a[row + x]);
                    let pb = u64::from(b[row + x]);
                    sa += pa;
                    sb += pb;
                    saa += pa * pa;
                    sbb += pb * pb;
                    sab += pa * pb;
                }
            }
            let ma = sa as f64 / n;
            let mb = sb as f64 / n;
            // Population (biased) variance/covariance, matching the reference
            // SSIM formulation.
            let va = saa as f64 / n - ma * ma;
            let vb = sbb as f64 / n - mb * mb;
            let cov = sab as f64 / n - ma * mb;
            total += ((2.0 * ma * mb + SSIM_C1) * (2.0 * cov + SSIM_C2))
                / ((ma * ma + mb * mb + SSIM_C1) * (va + vb + SSIM_C2));
        }
    }
    (total / (ys.len() * xs.len()) as f64).max(0.0)
}

/// True when more than two of the pixel's 3x3 neighbours (image-border virtual
/// neighbours count once) share its exact value, i.e. the pixel sits in a
/// locally flat region. Direct grayscale port of pixelmatch's
/// `hasManySiblings`.
fn has_many_siblings(img: &[u8], x: usize, y: usize, w: usize, h: usize) -> bool {
    let mut equal = usize::from(x == 0 || x == w - 1 || y == 0 || y == h - 1);
    let val = img[y * w + x];
    for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
        for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
            if (nx, ny) != (x, y) && img[ny * w + nx] == val {
                equal += 1;
                if equal > 2 {
                    return true;
                }
            }
        }
    }
    false
}

/// Anti-aliasing heuristic for a differing pixel at `(x, y)` of `img`
/// (grayscale adaptation of pixelmatch's `antialiased`; pixelmatch already
/// judges AA on brightness deltas, so the adaptation is dropping the YIQ color
/// step, not changing the logic): the pixel is a likely AA artifact when its
/// 3x3 neighbourhood in `img` has at most two equal siblings but both a darker
/// and a brighter sibling (a steep local gradient), and the darkest or
/// brightest such sibling sits in a locally flat region of BOTH images, i.e.
/// the surrounding structure is unchanged and only the edge blend moved.
fn antialiased(img: &[u8], other: &[u8], x: usize, y: usize, w: usize, h: usize) -> bool {
    let center = i32::from(img[y * w + x]);
    let mut equal = usize::from(x == 0 || x == w - 1 || y == 0 || y == h - 1);
    let (mut min_d, mut max_d) = (0i32, 0i32);
    let (mut min_pos, mut max_pos) = ((0usize, 0usize), (0usize, 0usize));
    for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
        for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
            if (nx, ny) == (x, y) {
                continue;
            }
            let delta = i32::from(img[ny * w + nx]) - center;
            if delta == 0 {
                // More than two equal siblings: flat area, definitely not AA.
                equal += 1;
                if equal > 2 {
                    return false;
                }
            } else if delta < min_d {
                min_d = delta;
                min_pos = (nx, ny);
            } else if delta > max_d {
                max_d = delta;
                max_pos = (nx, ny);
            }
        }
    }
    // No darker or no brighter sibling: not the middle of an edge blend.
    if min_d == 0 || max_d == 0 {
        return false;
    }
    (has_many_siblings(img, min_pos.0, min_pos.1, w, h)
        && has_many_siblings(other, min_pos.0, min_pos.1, w, h))
        || (has_many_siblings(img, max_pos.0, max_pos.1, w, h)
            && has_many_siblings(other, max_pos.0, max_pos.1, w, h))
}

/// AA-aware pixel-diff ratio of two grayscale images (row-major, one byte per
/// pixel): the fraction of pixels in `[0, 1]` whose absolute brightness
/// difference exceeds `threshold` AND that are not classified as anti-aliasing
/// artifacts (see [`antialiased`]; a pixel is excused when either image's
/// neighbourhood explains it as a moved edge blend). `0.0` means no visible
/// change. `threshold ≈ 25` (~10% of the 8-bit range, in the spirit of
/// pixelmatch's default 0.1 sensitivity) works well for screenshot content.
///
/// Deterministic: integer math except the final ratio division.
///
/// # Panics
/// Panics if `w == 0`, `h == 0`, or either buffer's length is not `w * h`.
pub fn diff_ratio(a: &[u8], b: &[u8], w: usize, h: usize, threshold: u8) -> f64 {
    assert_dims(a, w, h);
    assert_dims(b, w, h);
    let mut changed = 0usize;
    for y in 0..h {
        for x in 0..w {
            let d = (i32::from(a[y * w + x]) - i32::from(b[y * w + x])).unsigned_abs();
            if d > u32::from(threshold)
                && !antialiased(a, b, x, y, w, h)
                && !antialiased(b, a, x, y, w, h)
            {
                changed += 1;
            }
        }
    }
    changed as f64 / (w * h) as f64
}

/// Both change-sensitive scores for one tile: the single call the capture
/// worker makes per tile to feed `TileChangeScore` in
/// `packages/capture/src/change-detection.ts`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileScore {
    /// Mean SSIM in `[0, 1]`; `1.0` = identical (see [`ssim`]).
    pub ssim: f64,
    /// AA-aware changed-pixel fraction in `[0, 1]`; `0.0` = identical
    /// (see [`diff_ratio`]).
    pub diff_ratio: f64,
}

/// Compute [`ssim`] and [`diff_ratio`] for one tile pair.
///
/// # Panics
/// Panics if `w == 0`, `h == 0`, or either buffer's length is not `w * h`.
pub fn tile_score(a: &[u8], b: &[u8], w: usize, h: usize, threshold: u8) -> TileScore {
    TileScore {
        ssim: ssim(a, b, w, h),
        diff_ratio: diff_ratio(a, b, w, h, threshold),
    }
}

/// Number of differing bits between two 64-bit hashes.
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Whether two hashes are within `threshold` differing bits of each other.
/// A threshold of about 10 works well for [`dhash`] near-duplicate detection.
pub fn is_near_duplicate(a: u64, b: u64, threshold: u32) -> bool {
    hamming(a, b) <= threshold
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::golden;

    // --- synthetic image generators (mirrored in golden/vectors.json and in the
    // TypeScript golden test; integer math only so all implementations agree) ---

    fn gradient_h(w: usize, h: usize, shift: usize) -> Vec<u8> {
        let mut px = Vec::with_capacity(w * h);
        for _y in 0..h {
            for x in 0..w {
                let sx = (x + shift).min(w - 1);
                px.push((sx * 255 / (w - 1)) as u8);
            }
        }
        px
    }

    fn gradient_v(w: usize, h: usize) -> Vec<u8> {
        let mut px = Vec::with_capacity(w * h);
        for y in 0..h {
            for _x in 0..w {
                px.push((y * 255 / (h - 1)) as u8);
            }
        }
        px
    }

    fn inverted_gradient_h(w: usize, h: usize) -> Vec<u8> {
        gradient_h(w, h, 0).iter().map(|p| 255 - p).collect()
    }

    fn checkerboard(w: usize, h: usize, block: usize) -> Vec<u8> {
        let mut px = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                px.push(if (x / block + y / block).is_multiple_of(2) {
                    0
                } else {
                    255
                });
            }
        }
        px
    }

    /// Numerical-recipes LCG; pixel = top byte of the 32-bit state.
    fn lcg_noise(w: usize, h: usize, seed: u32) -> Vec<u8> {
        let mut s = seed;
        let mut px = Vec::with_capacity(w * h);
        for _ in 0..w * h {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            px.push((s >> 24) as u8);
        }
        px
    }

    fn brightened(px: &[u8], delta: u8) -> Vec<u8> {
        px.iter().map(|p| p.saturating_add(delta)).collect()
    }

    fn next_lcg(s: &mut u64) -> u64 {
        // 64-bit LCG (Knuth MMIX constants) for property tests.
        *s = s
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *s
    }

    #[test]
    fn identical_images_have_zero_distance() {
        let img = lcg_noise(64, 48, 7);
        assert_eq!(hamming(dhash(&img, 64, 48), dhash(&img, 64, 48)), 0);
        assert_eq!(hamming(phash(&img, 64, 48), phash(&img, 64, 48)), 0);
    }

    #[test]
    fn one_pixel_shift_is_a_near_duplicate() {
        let base = gradient_h(64, 48, 0);
        let shifted = gradient_h(64, 48, 1);
        let d = hamming(dhash(&base, 64, 48), dhash(&shifted, 64, 48));
        assert!(d <= 10, "dhash distance for 1px shift was {d}");
        assert!(is_near_duplicate(
            dhash(&base, 64, 48),
            dhash(&shifted, 64, 48),
            10
        ));
        let p = hamming(phash(&base, 64, 48), phash(&shifted, 64, 48));
        assert!(p <= 10, "phash distance for 1px shift was {p}");
    }

    #[test]
    fn small_brightness_change_is_a_near_duplicate() {
        let base = lcg_noise(64, 48, 42);
        let bright = brightened(&base, 4);
        let d = hamming(dhash(&base, 64, 48), dhash(&bright, 64, 48));
        assert!(d <= 10, "dhash distance for +4 brightness was {d}");
        let p = hamming(phash(&base, 64, 48), phash(&bright, 64, 48));
        assert!(p <= 10, "phash distance for +4 brightness was {p}");
    }

    #[test]
    fn structurally_different_images_are_far_apart() {
        let grad = gradient_h(64, 48, 0);
        let checker = checkerboard(64, 48, 8);
        let inverted = inverted_gradient_h(64, 48);
        let vertical = gradient_v(64, 48);
        let d_checker = hamming(dhash(&grad, 64, 48), dhash(&checker, 64, 48));
        assert!(
            d_checker > 20,
            "gradient vs checkerboard dhash distance was {d_checker}"
        );
        let d_inv = hamming(dhash(&grad, 64, 48), dhash(&inverted, 64, 48));
        assert!(
            d_inv > 20,
            "gradient vs inverted dhash distance was {d_inv}"
        );
        let d_vert = hamming(dhash(&grad, 64, 48), dhash(&vertical, 64, 48));
        assert!(
            d_vert > 20,
            "horizontal vs vertical gradient dhash distance was {d_vert}"
        );
        // phash caveat, pinned rather than hidden: analytically-sparse synthetic
        // images (pure gradients, exact checkerboards) have almost-all-zero DCT
        // spectra, so BOTH phash values sit near zero and their Hamming distance is
        // small, and the canonical pHash algorithm behaves the same way. Separation on
        // such structured-but-flat content is dhash's job (asserted above); phash
        // earns its keep on noise-like natural content (asserted below). Keep the
        // distance nonzero here so the two spectra at least never collapse together.
        let p_checker = hamming(phash(&grad, 64, 48), phash(&checker, 64, 48));
        assert!(
            p_checker > 0,
            "gradient vs checkerboard phash collapsed to equal hashes"
        );
        assert!(!is_near_duplicate(
            dhash(&grad, 64, 48),
            dhash(&checker, 64, 48),
            10
        ));
    }

    #[test]
    fn phash_separates_unrelated_natural_content() {
        // Independent noise images model unrelated screenshot content: their DCT
        // spectra are dense, so the median-threshold bits are informative and two
        // unrelated images should disagree on roughly half of them.
        for (s1, s2) in [(1u32, 2u32), (3, 999), (42, 4242)] {
            let a = lcg_noise(64, 48, s1);
            let b = lcg_noise(64, 48, s2);
            let p = hamming(phash(&a, 64, 48), phash(&b, 64, 48));
            assert!(
                p > 20,
                "phash distance for unrelated noise (seeds {s1},{s2}) was {p}"
            );
        }
    }

    #[test]
    fn hashing_is_deterministic_across_reconstructions() {
        for seed in [1u32, 2, 3, 999] {
            let a = lcg_noise(96, 64, seed);
            let b = lcg_noise(96, 64, seed);
            assert_eq!(dhash(&a, 96, 64), dhash(&b, 96, 64));
            assert_eq!(phash(&a, 96, 64), phash(&b, 96, 64));
        }
    }

    #[test]
    fn hamming_is_a_metric() {
        let mut s = 0xDEADBEEFu64;
        for _ in 0..200 {
            let a = next_lcg(&mut s);
            let b = next_lcg(&mut s);
            let c = next_lcg(&mut s);
            assert_eq!(hamming(a, a), 0);
            assert_eq!(hamming(a, b), hamming(b, a), "symmetry");
            assert!(
                hamming(a, c) <= hamming(a, b) + hamming(b, c),
                "triangle inequality: d({a},{c}) > d({a},{b}) + d({b},{c})"
            );
        }
    }

    #[test]
    fn tiny_and_exact_grid_sizes_work() {
        let one = [128u8];
        assert_eq!(hamming(dhash(&one, 1, 1), dhash(&one, 1, 1)), 0);
        let _ = phash(&one, 1, 1);
        let exact = lcg_noise(9, 8, 5);
        let _ = dhash(&exact, 9, 8);
        let exact32 = lcg_noise(32, 32, 5);
        let _ = phash(&exact32, 32, 32);
    }

    #[test]
    #[should_panic(expected = "gray buffer length must equal w * h")]
    fn wrong_buffer_length_panics() {
        let _ = dhash(&[0u8; 10], 4, 4);
    }

    // --- change-sensitive tile scores (ssim / diff_ratio / tile_score) ---

    const DIFF_THRESHOLD: u8 = 25;

    /// Hard vertical edge (0 → 255) at column `c` with a single-pixel
    /// anti-aliasing ramp (128) on the edge column: the classic artifact a
    /// sub-pixel layout shift produces.
    fn aa_ramp_edge(w: usize, h: usize, c: usize) -> Vec<u8> {
        let mut px = Vec::with_capacity(w * h);
        for _y in 0..h {
            for x in 0..w {
                px.push(match x.cmp(&c) {
                    std::cmp::Ordering::Less => 0,
                    std::cmp::Ordering::Equal => 128,
                    std::cmp::Ordering::Greater => 255,
                });
            }
        }
        px
    }

    #[test]
    fn identical_images_score_perfect() {
        // Exact equality is intentional: for a == b every per-window SSIM
        // numerator/denominator pair is the same computed expression, so each
        // window is exactly 1.0 and the mean of exact 1.0s is exactly 1.0.
        let img = lcg_noise(64, 48, 7);
        assert_eq!(ssim(&img, &img, 64, 48), 1.0);
        assert_eq!(diff_ratio(&img, &img, 64, 48, DIFF_THRESHOLD), 0.0);
        let score = tile_score(&img, &img, 64, 48, DIFF_THRESHOLD);
        assert_eq!(
            score,
            TileScore {
                ssim: 1.0,
                diff_ratio: 0.0
            }
        );
    }

    #[test]
    fn small_brightness_shift_scores_as_unchanged() {
        // +4 brightness: perfectly correlated structure, means shift slightly
        // ⇒ SSIM stays above the 0.99 decision threshold and no pixel clears
        // the diff threshold.
        let base = lcg_noise(64, 48, 42);
        let bright = brightened(&base, 4);
        let s = ssim(&base, &bright, 64, 48);
        assert!(s > 0.99, "ssim for +4 brightness was {s}");
        assert_eq!(diff_ratio(&base, &bright, 64, 48, DIFF_THRESHOLD), 0.0);
    }

    #[test]
    fn structurally_different_images_score_as_changed() {
        let grad = gradient_h(64, 48, 0);
        let checker = checkerboard(64, 48, 8);
        let s = ssim(&grad, &checker, 64, 48);
        assert!(s < 0.5, "gradient vs checkerboard ssim was {s}");
        let d = diff_ratio(&grad, &checker, 64, 48, DIFF_THRESHOLD);
        assert!(d > 0.3, "gradient vs checkerboard diff_ratio was {d}");
    }

    #[test]
    fn antialiasing_shift_counts_fewer_pixels_than_naive_diff() {
        // A 1px shift of an anti-aliased hard edge: the naive diff flags the
        // whole edge (two full columns clear the threshold), while the AA
        // heuristic recognizes every one of those pixels as a moved edge blend.
        let (w, h) = (32usize, 16usize);
        let a = aa_ramp_edge(w, h, 8);
        let b = aa_ramp_edge(w, h, 9);
        let naive: usize = a
            .iter()
            .zip(&b)
            .filter(|(pa, pb)| {
                (i32::from(**pa) - i32::from(**pb)).unsigned_abs() > u32::from(DIFF_THRESHOLD)
            })
            .count();
        assert_eq!(naive, 2 * h, "expected the two edge columns to differ");
        let aa_changed = diff_ratio(&a, &b, w, h, DIFF_THRESHOLD) * (w * h) as f64;
        assert!(
            aa_changed < naive as f64,
            "AA-aware diff ({aa_changed}) should count fewer pixels than naive ({naive})"
        );
        assert_eq!(aa_changed, 0.0, "the pure edge shift should be all-AA");
    }

    #[test]
    fn tile_scores_are_symmetric_and_in_range() {
        let mut s = 0xC0FFEEu64;
        for _ in 0..20 {
            let seed_a = next_lcg(&mut s) as u32;
            let seed_b = next_lcg(&mut s) as u32;
            let a = lcg_noise(48, 32, seed_a);
            let b = lcg_noise(48, 32, seed_b);
            assert_eq!(ssim(&a, &a, 48, 32), 1.0);
            assert_eq!(diff_ratio(&a, &a, 48, 32, DIFF_THRESHOLD), 0.0);
            // Both kernels are symmetric expressions, so bit-equality holds.
            assert_eq!(ssim(&a, &b, 48, 32), ssim(&b, &a, 48, 32));
            assert_eq!(
                diff_ratio(&a, &b, 48, 32, DIFF_THRESHOLD),
                diff_ratio(&b, &a, 48, 32, DIFF_THRESHOLD)
            );
            let score = tile_score(&a, &b, 48, 32, DIFF_THRESHOLD);
            assert!((0.0..=1.0).contains(&score.ssim), "ssim {}", score.ssim);
            assert!(
                (0.0..=1.0).contains(&score.diff_ratio),
                "diff_ratio {}",
                score.diff_ratio
            );
        }
    }

    #[test]
    fn tile_scores_are_deterministic_across_reconstructions() {
        for seed in [1u32, 2, 999] {
            let a1 = lcg_noise(96, 64, seed);
            let a2 = lcg_noise(96, 64, seed);
            let b1 = lcg_noise(96, 64, seed + 1);
            let b2 = lcg_noise(96, 64, seed + 1);
            assert_eq!(
                tile_score(&a1, &b1, 96, 64, DIFF_THRESHOLD),
                tile_score(&a2, &b2, 96, 64, DIFF_THRESHOLD)
            );
        }
    }

    #[test]
    fn tiny_images_score_without_panicking() {
        // Below the 8x8 SSIM window ⇒ single full-image window.
        let one = [128u8];
        assert_eq!(ssim(&one, &one, 1, 1), 1.0);
        assert_eq!(diff_ratio(&one, &one, 1, 1, DIFF_THRESHOLD), 0.0);
        let a = lcg_noise(5, 3, 1);
        let b = lcg_noise(5, 3, 2);
        let score = tile_score(&a, &b, 5, 3, DIFF_THRESHOLD);
        assert!((0.0..=1.0).contains(&score.ssim));
        assert!((0.0..=1.0).contains(&score.diff_ratio));
    }

    #[test]
    #[should_panic(expected = "gray buffer length must equal w * h")]
    fn ssim_wrong_buffer_length_panics() {
        let _ = ssim(&[0u8; 10], &[0u8; 16], 4, 4);
    }

    #[test]
    fn golden_pair_scores_are_what_the_file_says() {
        for p in golden::golden_pairs() {
            let (pa, w, h) = golden::golden_vectors()
                .iter()
                .find(|v| v.name == p.a)
                .expect("pair image a")
                .image();
            let (pb, _, _) = golden::golden_vectors()
                .iter()
                .find(|v| v.name == p.b)
                .expect("pair image b")
                .image();
            let score = tile_score(&pa, &pb, w, h, p.threshold);
            assert_eq!(format!("{:.12}", score.ssim), p.ssim, "{} vs {}", p.a, p.b);
            assert_eq!(
                format!("{:.12}", score.diff_ratio),
                p.diff_ratio,
                "{} vs {}",
                p.a,
                p.b
            );
        }
    }

    #[test]
    fn golden_vectors_match_checked_in_file() {
        // The checked-in JSON is the cross-language contract (the TypeScript test in
        // packages/capture/test/dedup-golden.test.ts consumes it). Regenerate with:
        //   cargo run --example gen_golden > golden/vectors.json
        assert_eq!(
            golden::render_golden_json(),
            include_str!("../golden/vectors.json"),
            "golden/vectors.json is stale; regenerate with `cargo run --example gen_golden > golden/vectors.json`"
        );
    }

    #[test]
    fn golden_hashes_are_what_the_file_says() {
        for v in golden::golden_vectors() {
            let (px, w, h) = v.image();
            assert_eq!(
                format!("{:016x}", dhash(&px, w, h)),
                v.dhash_hex,
                "{}",
                v.name
            );
            assert_eq!(
                format!("{:016x}", phash(&px, w, h)),
                v.phash_hex,
                "{}",
                v.name
            );
        }
    }
}

/// Golden-vector definitions shared by the sync test and the `gen_golden` example.
/// Not part of the public dedup API; exposed only so the example binary can render
/// the checked-in `golden/vectors.json`.
#[doc(hidden)]
pub mod golden {
    use super::{dhash, phash, tile_score};

    pub struct GoldenVector {
        pub name: &'static str,
        pub kind: &'static str,
        pub w: usize,
        pub h: usize,
        pub param: usize,
        pub dhash_hex: String,
        pub phash_hex: String,
    }

    impl GoldenVector {
        pub fn image(&self) -> (Vec<u8>, usize, usize) {
            (
                generate(self.kind, self.w, self.h, self.param),
                self.w,
                self.h,
            )
        }
    }

    /// Deterministic generators mirrored byte-for-byte in the TypeScript golden test.
    pub fn generate(kind: &str, w: usize, h: usize, param: usize) -> Vec<u8> {
        let mut px = Vec::with_capacity(w * h);
        match kind {
            // param = horizontal shift in pixels
            "gradient-h" => {
                for _y in 0..h {
                    for x in 0..w {
                        let sx = (x + param).min(w - 1);
                        px.push((sx * 255 / (w - 1)) as u8);
                    }
                }
            }
            "gradient-v" => {
                for y in 0..h {
                    for _x in 0..w {
                        px.push((y * 255 / (h - 1)) as u8);
                    }
                }
            }
            "inverted-gradient-h" => {
                for _y in 0..h {
                    for x in 0..w {
                        px.push(255 - (x * 255 / (w - 1)) as u8);
                    }
                }
            }
            // param = block size in pixels
            "checkerboard" => {
                for y in 0..h {
                    for x in 0..w {
                        px.push(if (x / param + y / param).is_multiple_of(2) {
                            0
                        } else {
                            255
                        });
                    }
                }
            }
            // param = LCG seed; pixel = top byte of 32-bit state
            "lcg-noise" => {
                let mut s = param as u32;
                for _ in 0..w * h {
                    s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    px.push((s >> 24) as u8);
                }
            }
            other => panic!("unknown generator kind: {other}"),
        }
        px
    }

    pub fn golden_vectors() -> Vec<GoldenVector> {
        let specs: [(&str, &str, usize, usize, usize); 6] = [
            ("gradient-h-64x48", "gradient-h", 64, 48, 0),
            ("gradient-h-64x48-shift1", "gradient-h", 64, 48, 1),
            ("gradient-v-64x48", "gradient-v", 64, 48, 0),
            (
                "inverted-gradient-h-64x48",
                "inverted-gradient-h",
                64,
                48,
                0,
            ),
            ("checkerboard-64x48-b8", "checkerboard", 64, 48, 8),
            ("lcg-noise-64x48-seed42", "lcg-noise", 64, 48, 42),
        ];
        specs
            .iter()
            .map(|&(name, kind, w, h, param)| {
                let px = generate(kind, w, h, param);
                GoldenVector {
                    name,
                    kind,
                    w,
                    h,
                    param,
                    dhash_hex: format!("{:016x}", dhash(&px, w, h)),
                    phash_hex: format!("{:016x}", phash(&px, w, h)),
                }
            })
            .collect()
    }

    /// Change-sensitive scores for a named pair of golden images. The pairs
    /// cover the decision seam's cases: identical (confirm-unchanged), a 1px
    /// shift (near-duplicate), and structurally different content (must decide
    /// changed even though pHash may be blind to it).
    pub struct GoldenPair {
        pub a: &'static str,
        pub b: &'static str,
        /// AA-aware diff brightness threshold (see `diff_ratio`).
        pub threshold: u8,
        /// `ssim` formatted with 12 fractional digits (f64 ops are IEEE-exact,
        /// so the value is bit-stable across platforms).
        pub ssim: String,
        /// `diff_ratio` formatted with 12 fractional digits.
        pub diff_ratio: String,
    }

    /// Fixed diff threshold used for all golden pairs (~10% of the 8-bit
    /// range, in the spirit of pixelmatch's default 0.1 sensitivity).
    pub const GOLDEN_DIFF_THRESHOLD: u8 = 25;

    pub fn golden_pairs() -> Vec<GoldenPair> {
        let pair_names: [(&str, &str); 6] = [
            ("gradient-h-64x48", "gradient-h-64x48"),
            ("lcg-noise-64x48-seed42", "lcg-noise-64x48-seed42"),
            ("gradient-h-64x48", "gradient-h-64x48-shift1"),
            ("gradient-h-64x48", "gradient-v-64x48"),
            ("gradient-h-64x48", "inverted-gradient-h-64x48"),
            ("gradient-h-64x48", "checkerboard-64x48-b8"),
        ];
        let vectors = golden_vectors();
        let image = |name: &str| -> (Vec<u8>, usize, usize) {
            vectors
                .iter()
                .find(|v| v.name == name)
                .unwrap_or_else(|| panic!("unknown golden image: {name}"))
                .image()
        };
        pair_names
            .iter()
            .map(|&(a, b)| {
                let (pa, w, h) = image(a);
                let (pb, _, _) = image(b);
                let score = tile_score(&pa, &pb, w, h, GOLDEN_DIFF_THRESHOLD);
                GoldenPair {
                    a,
                    b,
                    threshold: GOLDEN_DIFF_THRESHOLD,
                    ssim: format!("{:.12}", score.ssim),
                    diff_ratio: format!("{:.12}", score.diff_ratio),
                }
            })
            .collect()
    }

    /// Canonical serialization of the golden vectors (the exact bytes of
    /// `golden/vectors.json`).
    pub fn render_golden_json() -> String {
        let mut out = String::from(
            "{\n  \"$comment\": \"Cross-language golden vectors for capture-dedup. Generated by `cargo run --example gen_golden > golden/vectors.json`; consumed by src/lib.rs tests and packages/capture/test/dedup-golden.test.ts. dhash is the cross-language contract (integer math); phash is Rust-reference only. pairs carry Rust-computed ssim/diff_ratio tile scores; the TS test feeds them through the change-detection decision seam rather than re-deriving the float math.\",\n  \"vectors\": [\n",
        );
        let vectors = golden_vectors();
        for (i, v) in vectors.iter().enumerate() {
            out.push_str(&format!(
                "    {{ \"name\": \"{}\", \"kind\": \"{}\", \"w\": {}, \"h\": {}, \"param\": {}, \"dhash\": \"{}\", \"phash\": \"{}\" }}{}\n",
                v.name,
                v.kind,
                v.w,
                v.h,
                v.param,
                v.dhash_hex,
                v.phash_hex,
                if i + 1 == vectors.len() { "" } else { "," }
            ));
        }
        out.push_str("  ],\n  \"pairs\": [\n");
        let pairs = golden_pairs();
        for (i, p) in pairs.iter().enumerate() {
            out.push_str(&format!(
                "    {{ \"a\": \"{}\", \"b\": \"{}\", \"threshold\": {}, \"ssim\": {}, \"diff_ratio\": {} }}{}\n",
                p.a,
                p.b,
                p.threshold,
                p.ssim,
                p.diff_ratio,
                if i + 1 == pairs.len() { "" } else { "," }
            ));
        }
        out.push_str("  ]\n}\n");
        out
    }
}
