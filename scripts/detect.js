/**
 * Grid detection — pure math, no Foundry dependencies.
 *
 * Works on 1D luminance profiles: colSums[x] = sum of luminance in column x,
 * rowSums[y] = sum of luminance in row y. A printed grid line is a thin stripe
 * that is darker (or lighter) along the whole map, so it survives summing
 * while trees, rocks and texture average out.
 */

/** Second-derivative "line" response of a 1D profile, absolute value. */
export function lineResponse(sums, step = 2) {
  const n = sums.length;
  const out = new Float64Array(n);
  for (let i = step; i < n - step; i++) {
    out[i] = Math.abs(2 * sums[i] - sums[i - step] - sums[i + step]);
  }
  return out;
}

function boxBlur(a, radius) {
  const n = a.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius), hi = Math.min(n, i + radius + 1);
    out[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Fold the profile modulo period p into bins.
 * Returns { score, phase, z } where phase is the line position in [0, p).
 */
export function fold(a, p, { margin = 4, binsPerPixel = 1 } = {}) {
  const B = Math.max(6, Math.round(p * binsPerPixel));
  const sum = new Float64Array(B);
  const cnt = new Float64Array(B);
  const n = a.length;
  for (let i = margin; i < n - margin; i++) {
    const pos = i % p;
    let b = Math.floor((pos / p) * B);
    if (b >= B) b = B - 1;
    sum[b] += a[i];
    cnt[b] += 1;
  }
  let mean = 0, k = 0;
  const avg = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    avg[b] = cnt[b] ? sum[b] / cnt[b] : 0;
    mean += avg[b];
    k++;
  }
  mean /= k;
  let max = -Infinity, arg = 0, varSum = 0;
  for (let b = 0; b < B; b++) {
    if (avg[b] > max) { max = avg[b]; arg = b; }
    varSum += (avg[b] - mean) ** 2;
  }
  const sd = Math.sqrt(varSum / B) || 1e-9;
  // Sub-bin peak position with parabolic interpolation (circular)
  const l = avg[(arg - 1 + B) % B], r = avg[(arg + 1) % B];
  const denom = l - 2 * max + r;
  const frac = denom !== 0 ? 0.5 * (l - r) / denom : 0;
  let phase = ((arg + 0.5 + frac) * p) / B + 0.5; // +0.5: index i is the pixel whose centre is i+0.5
  phase = ((phase % p) + p) % p;
  return { score: max - mean, phase, z: (max - mean) / sd };
}

/**
 * Find the grid period and phase in one axis.
 * @param {Float64Array|number[]} sums  luminance sums along that axis
 * @param {object} opts  { minP, maxP }
 */
export function detectAxis(sums, { minP = 20, maxP = 600 } = {}) {
  const raw = lineResponse(sums);
  const n = raw.length;
  maxP = Math.min(maxP, n / 3);
  if (maxP <= minP) return null;
  const blurred = boxBlur(raw, 3);

  // Coarse search: step small enough that the accumulated drift over the
  // whole map stays within the blur width.
  const cands = [];
  for (let p = minP; p <= maxP; ) {
    const f = fold(blurred, p);
    cands.push({ p, score: f.score });
    p += Math.max(0.02, (3 * p) / n);
  }
  let best = 0;
  for (const c of cands) best = Math.max(best, c.score);
  if (best <= 0) return null;

  // Local maxima that score close to the best. Multiples of the true period
  // (2x, 3x…) score about as high, so take the smallest strong one.
  const peaks = [];
  for (let i = 1; i < cands.length - 1; i++) {
    const c = cands[i];
    if (c.score >= cands[i - 1].score && c.score >= cands[i + 1].score && c.score >= 0.75 * best) {
      peaks.push(c);
    }
  }
  if (!peaks.length) peaks.push(cands.reduce((a, b) => (b.score > a.score ? b : a)));
  peaks.sort((a, b) => a.p - b.p);
  const coarse = peaks[0].p;

  return refineAxis(raw, coarse, n);
}

/** Refine a coarse period on the unblurred response. */
export function refineAxis(raw, coarse, n = raw.length, span = null) {
  const delta = Math.max(0.02, (3 * coarse) / n);
  const lo = coarse - (span ?? 2 * delta), hi = coarse + (span ?? 2 * delta);
  let bestP = coarse, bestScore = -Infinity;
  const steps = 200;
  for (let s = 0; s <= steps; s++) {
    const p = lo + ((hi - lo) * s) / steps;
    if (p < 4) continue;
    const f = fold(raw, p);
    if (f.score > bestScore) { bestScore = f.score; bestP = p; }
  }
  // Second, finer pass
  const d2 = (hi - lo) / steps;
  for (let s = -20; s <= 20; s++) {
    const p = bestP + (d2 * s) / 10;
    const f = fold(raw, p);
    if (f.score > bestScore) { bestScore = f.score; bestP = p; }
  }
  const f = fold(raw, bestP, { binsPerPixel: 2 });
  return { period: bestP, phase: f.phase, z: f.z, score: bestScore };
}

/**
 * Detect the grid in both axes and reconcile them (square grid assumed,
 * but each axis keeps its own exact period so stretched maps still fit).
 */
export function detectGrid(colSums, rowSums, opts = {}) {
  let x = detectAxis(colSums, opts);
  let y = detectAxis(rowSums, opts);
  if (!x && !y) return null;
  const rawX = lineResponse(colSums), rawY = lineResponse(rowSums);

  // If one axis locked onto a multiple of the other, re-search it near the smaller one.
  if (x && y) {
    const ratio = x.period / y.period;
    if (Math.abs(ratio - 1) > 0.05) {
      const target = Math.min(x.period, y.period);
      const span = target * 0.05;
      if (x.period > y.period) x = refineAxis(rawX, target, rawX.length, span);
      else y = refineAxis(rawY, target, rawY.length, span);
    }
  } else if (x && !y) {
    y = refineAxis(rawY, x.period, rawY.length, x.period * 0.05);
  } else if (!x && y) {
    x = refineAxis(rawX, y.period, rawX.length, y.period * 0.05);
  }
  return { x, y };
}

/**
 * Turn a detection into new scene values.
 * @param {object} det        result of detectGrid
 * @param {number} imgW       background image width (px)
 * @param {number} imgH       background image height (px)
 * @param {number} gridSize   desired Foundry grid size (integer px)
 */
export function planAlignment(det, imgW, imgH, gridSize) {
  const G = gridSize;
  const sx = G / det.x.period, sy = G / det.y.period;
  const width = Math.round(imgW * sx);
  const height = Math.round(imgH * sy);
  const realSx = width / imgW, realSy = height / imgH;
  const norm = (v) => {
    let o = -((v % G) + G) % G;
    if (o <= -G / 2) o += G;
    return Math.round(o);
  };
  const offsetX = norm(det.x.phase * realSx);
  const offsetY = norm(det.y.phase * realSy);
  return {
    gridSize: G,
    width, height, offsetX, offsetY,
    squaresX: imgW / det.x.period,
    squaresY: imgH / det.y.period
  };
}
