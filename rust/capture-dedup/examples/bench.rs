//! Release-mode timing harness: `cargo run --release --example bench`.
//! Hashes and scores synthetic 1920x1080 grayscale frames; reports ns/op for
//! dhash + phash (single frame) and ssim + diff_ratio (frame pair).

use std::hint::black_box;
use std::time::Instant;

fn frame(w: usize, h: usize, seed: u32) -> Vec<u8> {
    // LCG noise (same generator family as the tests) — worst case for the
    // hashes and, being ~everywhere-different, for the AA-aware diff too.
    let mut s = seed;
    let mut px = Vec::with_capacity(w * h);
    for _ in 0..w * h {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        px.push((s >> 24) as u8);
    }
    px
}

fn time(runs: u32, mut f: impl FnMut()) -> u128 {
    let t = Instant::now();
    for _ in 0..runs {
        f();
    }
    t.elapsed().as_nanos() / u128::from(runs)
}

fn report(name: &str, ns: u128) {
    println!("{name}: {ns} ns/op ({:.2} ms)", ns as f64 / 1e6);
}

fn main() {
    const W: usize = 1920;
    const H: usize = 1080;
    const RUNS: u32 = 100;
    const DIFF_THRESHOLD: u8 = 25;
    let px = frame(W, H, 42);
    let px2 = frame(W, H, 43);

    // Warm-up.
    black_box(capture_dedup::dhash(black_box(&px), W, H));
    black_box(capture_dedup::phash(black_box(&px), W, H));
    black_box(capture_dedup::ssim(black_box(&px), black_box(&px2), W, H));
    black_box(capture_dedup::diff_ratio(
        black_box(&px),
        black_box(&px2),
        W,
        H,
        DIFF_THRESHOLD,
    ));

    println!("frame {W}x{H}, {RUNS} runs");
    report(
        "dhash",
        time(RUNS, || {
            black_box(capture_dedup::dhash(black_box(&px), W, H));
        }),
    );
    report(
        "phash",
        time(RUNS, || {
            black_box(capture_dedup::phash(black_box(&px), W, H));
        }),
    );
    report(
        "ssim",
        time(RUNS, || {
            black_box(capture_dedup::ssim(black_box(&px), black_box(&px2), W, H));
        }),
    );
    report(
        "diff_ratio",
        time(RUNS, || {
            black_box(capture_dedup::diff_ratio(
                black_box(&px),
                black_box(&px2),
                W,
                H,
                DIFF_THRESHOLD,
            ));
        }),
    );
    // The realistic recheck path: comparing against a matching baseline, so
    // few pixels clear the threshold and the AA machinery rarely fires.
    let bright = px.iter().map(|p| p.saturating_add(4)).collect::<Vec<_>>();
    report(
        "diff_ratio (near-identical pair)",
        time(RUNS, || {
            black_box(capture_dedup::diff_ratio(
                black_box(&px),
                black_box(&bright),
                W,
                H,
                DIFF_THRESHOLD,
            ));
        }),
    );
}
