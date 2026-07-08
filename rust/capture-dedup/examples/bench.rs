//! Release-mode timing harness: `cargo run --release --example bench`.
//! Hashes a synthetic 1920x1080 grayscale frame; reports ns/op for dhash + phash.

use std::hint::black_box;
use std::time::Instant;

fn frame(w: usize, h: usize) -> Vec<u8> {
    // LCG noise (same generator family as the tests) — worst case for both hashes.
    let mut s = 42u32;
    let mut px = Vec::with_capacity(w * h);
    for _ in 0..w * h {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        px.push((s >> 24) as u8);
    }
    px
}

fn main() {
    const W: usize = 1920;
    const H: usize = 1080;
    const RUNS: u32 = 100;
    let px = frame(W, H);

    // Warm-up.
    black_box(capture_dedup::dhash(black_box(&px), W, H));
    black_box(capture_dedup::phash(black_box(&px), W, H));

    let t = Instant::now();
    for _ in 0..RUNS {
        black_box(capture_dedup::dhash(black_box(&px), W, H));
    }
    let dhash_ns = t.elapsed().as_nanos() / u128::from(RUNS);

    let t = Instant::now();
    for _ in 0..RUNS {
        black_box(capture_dedup::phash(black_box(&px), W, H));
    }
    let phash_ns = t.elapsed().as_nanos() / u128::from(RUNS);

    println!("frame {W}x{H}, {RUNS} runs");
    println!(
        "dhash: {} ns/op ({:.2} ms)",
        dhash_ns,
        dhash_ns as f64 / 1e6
    );
    println!(
        "phash: {} ns/op ({:.2} ms)",
        phash_ns,
        phash_ns as f64 / 1e6
    );
}
