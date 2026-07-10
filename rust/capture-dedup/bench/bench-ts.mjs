// Node timing counterpart to `cargo run --release --example bench`.
// Same 1920x1080 LCG frames, same algorithms: 9x8 dhash (mirrors the
// golden-test TS) plus faithful ports of the ssim / diff_ratio kernels from
// src/lib.rs so the Rust-vs-TS comparison is like-for-like.
// Run: node rust/capture-dedup/bench/bench-ts.mjs

function frame(w, h, seed) {
  let s = seed >>> 0;
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

// --- ssim / diff_ratio ports of src/lib.rs (same window/stride/thresholds) ---

const SSIM_WINDOW = 8;
const SSIM_STRIDE = 4;
const SSIM_C1 = 6.5025;
const SSIM_C2 = 58.5225;

function windowStarts(len, win, stride) {
  if (len <= win) return [0];
  const starts = [];
  for (let s = 0; s <= len - win; s += stride) starts.push(s);
  if (starts[starts.length - 1] !== len - win) starts.push(len - win);
  return starts;
}

function ssim(a, b, w, h) {
  const ys = windowStarts(h, SSIM_WINDOW, SSIM_STRIDE);
  const xs = windowStarts(w, SSIM_WINDOW, SSIM_STRIDE);
  const wh = Math.min(SSIM_WINDOW, h);
  const ww = Math.min(SSIM_WINDOW, w);
  const n = wh * ww;
  let total = 0;
  for (const y0 of ys) {
    for (const x0 of xs) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = y0; y < y0 + wh; y++) {
        const row = y * w;
        for (let x = x0; x < x0 + ww; x++) {
          const pa = a[row + x];
          const pb = b[row + x];
          sa += pa;
          sb += pb;
          saa += pa * pa;
          sbb += pb * pb;
          sab += pa * pb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total +=
        ((2 * ma * mb + SSIM_C1) * (2 * cov + SSIM_C2)) /
        ((ma * ma + mb * mb + SSIM_C1) * (va + vb + SSIM_C2));
    }
  }
  return Math.max(total / (ys.length * xs.length), 0);
}

function hasManySiblings(img, x, y, w, h) {
  let equal = x === 0 || x === w - 1 || y === 0 || y === h - 1 ? 1 : 0;
  const val = img[y * w + x];
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, h - 1); ny++) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, w - 1); nx++) {
      if ((nx !== x || ny !== y) && img[ny * w + nx] === val) {
        equal += 1;
        if (equal > 2) return true;
      }
    }
  }
  return false;
}

function antialiased(img, other, x, y, w, h) {
  const center = img[y * w + x];
  let equal = x === 0 || x === w - 1 || y === 0 || y === h - 1 ? 1 : 0;
  let minD = 0, maxD = 0;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, h - 1); ny++) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, w - 1); nx++) {
      if (nx === x && ny === y) continue;
      const delta = img[ny * w + nx] - center;
      if (delta === 0) {
        equal += 1;
        if (equal > 2) return false;
      } else if (delta < minD) {
        minD = delta;
        minX = nx;
        minY = ny;
      } else if (delta > maxD) {
        maxD = delta;
        maxX = nx;
        maxY = ny;
      }
    }
  }
  if (minD === 0 || maxD === 0) return false;
  return (
    (hasManySiblings(img, minX, minY, w, h) && hasManySiblings(other, minX, minY, w, h)) ||
    (hasManySiblings(img, maxX, maxY, w, h) && hasManySiblings(other, maxX, maxY, w, h))
  );
}

function diffRatio(a, b, w, h, threshold) {
  let changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs(a[y * w + x] - b[y * w + x]);
      if (d > threshold && !antialiased(a, b, x, y, w, h) && !antialiased(b, a, x, y, w, h)) {
        changed += 1;
      }
    }
  }
  return changed / (w * h);
}

// --- harness ---

const W = 1920;
const H = 1080;
const RUNS = 100;
const DIFF_THRESHOLD = 25;
const px = frame(W, H, 42);
const px2 = frame(W, H, 43);
const bright = Uint8Array.from(px, (p) => Math.min(p + 4, 255));

function time(name, runs, f) {
  for (let i = 0; i < 3; i++) f(); // warm-up (JIT)
  const t = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < runs; i++) sink += f();
  const ns = Number(process.hrtime.bigint() - t) / runs;
  console.log(`${name}: ${Math.round(ns)} ns/op (${(ns / 1e6).toFixed(2)} ms) [sink ${sink}]`);
}

console.log(`frame ${W}x${H}, ${RUNS} runs`);
{
  for (let i = 0; i < 10; i++) dhash(px, W, H);
  const t = process.hrtime.bigint();
  let sink = 0n;
  for (let i = 0; i < RUNS; i++) sink ^= dhash(px, W, H);
  const ns = Number(process.hrtime.bigint() - t) / RUNS;
  console.log(`dhash: ${Math.round(ns)} ns/op (${(ns / 1e6).toFixed(2)} ms) [sink ${sink.toString(16)}]`);
}
time("ssim", RUNS, () => ssim(px, px2, W, H));
time("diff_ratio", 10, () => diffRatio(px, px2, W, H, DIFF_THRESHOLD));
time("diff_ratio (near-identical pair)", RUNS, () => diffRatio(px, bright, W, H, DIFF_THRESHOLD));
