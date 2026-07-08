// Node timing counterpart to `cargo run --release --example bench`.
// Same 1920x1080 LCG frame, same 9x8 dhash algorithm (mirrors the golden-test TS).
// Run: node rust/capture-dedup/bench/bench-ts.mjs

function frame(w, h) {
  let s = 42 >>> 0;
  const px = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    px[k] = s >>> 24;
  }
  return px;
}

function cellBounds(i, src, dst) {
  const start = Math.floor((i * src) / dst);
  const end = Math.floor(((i + 1) * src) / dst);
  return end <= start ? [start, start + 1] : [start, end];
}

function dhash(gray, w, h) {
  const grid = [];
  for (let row = 0; row < 8; row++) {
    const [y0, y1] = cellBounds(row, h, 8);
    const cells = [];
    for (let col = 0; col < 9; col++) {
      const [x0, x1] = cellBounds(col, w, 9);
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * w + x];
      cells.push(Math.floor(sum / ((y1 - y0) * (x1 - x0))));
    }
    grid.push(cells);
  }
  let hash = 0n;
  for (const row of grid)
    for (let col = 0; col < 8; col++) {
      hash <<= 1n;
      if (row[col] < row[col + 1]) hash |= 1n;
    }
  return hash;
}

const W = 1920;
const H = 1080;
const RUNS = 100;
const px = frame(W, H);

// Warm-up (JIT).
for (let i = 0; i < 10; i++) dhash(px, W, H);

const t = process.hrtime.bigint();
let sink = 0n;
for (let i = 0; i < RUNS; i++) sink ^= dhash(px, W, H);
const ns = Number(process.hrtime.bigint() - t) / RUNS;
console.log(`frame ${W}x${H}, ${RUNS} runs (sink ${sink.toString(16)})`);
console.log(`dhash: ${Math.round(ns)} ns/op (${(ns / 1e6).toFixed(2)} ms)`);
