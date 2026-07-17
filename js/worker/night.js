/* =========================================================
 * night.js — Night mode v2 kiểu PhotonCamera/HDR+ (chạy trong worker)
 * Burst → pyramid xám → chọn frame nét nhất làm tham chiếu → căn chỉnh
 * tịnh tiến coarse-to-fine → merge bền vững (soft outlier rejection kiểu
 * Wiener, chống ghost) → khử nhiễu chroma → gamma → auto-levels bảo vệ
 * highlight → unsharp. Cũng cung cấp exposureFusion (HDR bracketing).
 *
 * Rung tay ở thang thời gian burst ≈ tịnh tiến → chỉ ước lượng shift toàn
 * cục (dx,dy). Vùng tĩnh trung bình ~8 frame (~3 stop bớt nhiễu); chủ thể
 * chuyển động rơi về frame tham chiếu → không ghost.
 * ========================================================= */
import { gamma, unsharpMaskData, blurAlpha } from "../enhance-core.js";

const DOWN_W = 256; // bề rộng tầng luma nhỏ nhất của pyramid

// -------- Luma downscale (area-average) về ~DOWN_W --------
function lumaDown(img, w, h, targetW) {
  const scale = Math.max(1, Math.floor(w / targetW));
  const lw = Math.max(1, Math.floor(w / scale));
  const lh = Math.max(1, Math.floor(h / scale));
  const out = new Float32Array(lw * lh);
  const d = img.data;
  for (let ly = 0; ly < lh; ly++) {
    for (let lx = 0; lx < lw; lx++) {
      let sum = 0, cnt = 0;
      const x0 = lx * scale, y0 = ly * scale;
      for (let yy = 0; yy < scale; yy++) {
        const sy = y0 + yy; if (sy >= h) break;
        for (let xx = 0; xx < scale; xx++) {
          const sx = x0 + xx; if (sx >= w) break;
          const i = (sy * w + sx) * 4;
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          cnt++;
        }
      }
      out[ly * lw + lx] = cnt ? sum / cnt : 0;
    }
  }
  return { data: out, w: lw, h: lh, scale };
}

function halfRes(lvl) {
  const { data, w, h } = lvl;
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const x0 = x * 2, y0 = y * 2;
      let s = data[y0 * w + x0], c = 1;
      if (x0 + 1 < w) { s += data[y0 * w + x0 + 1]; c++; }
      if (y0 + 1 < h) {
        s += data[(y0 + 1) * w + x0]; c++;
        if (x0 + 1 < w) { s += data[(y0 + 1) * w + x0 + 1]; c++; }
      }
      out[y * nw + x] = s / c;
    }
  }
  return { data: out, w: nw, h: nh };
}

function pyramid(img, w, h) {
  const l0 = lumaDown(img, w, h, DOWN_W);
  const l1 = halfRes(l0);
  const l2 = halfRes(l1);
  return [l0, l1, l2, l0.scale];
}

// Variance của Laplacian 3×3 (độ nét)
function lapVar(lvl) {
  const { data, w, h } = lvl;
  if (w < 3 || h < 3) return 0;
  let mean = 0, n = 0;
  const lap = new Float32Array((w - 2) * (h - 2));
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = 4 * data[y * w + x] - data[y * w + x - 1] - data[y * w + x + 1]
        - data[(y - 1) * w + x] - data[(y + 1) * w + x];
      lap[k++] = v; mean += v; n++;
    }
  }
  if (!n) return 0;
  mean /= n;
  let va = 0;
  for (let i = 0; i < n; i++) { const dv = lap[i] - mean; va += dv * dv; }
  return va / n;
}

// SAD giữa ref và cand dịch (dx,dy) — trung bình trên vùng chồng
function sad(ref, cand, dx, dy) {
  const rd = ref.data, cd = cand.data, w = ref.w, h = ref.h;
  let sum = 0, cnt = 0;
  for (let y = 0; y < h; y++) {
    const sy = y + dy; if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + dx; if (sx < 0 || sx >= w) continue;
      sum += Math.abs(rd[y * w + x] - cd[sy * w + sx]); cnt++;
    }
  }
  return cnt ? sum / cnt : Infinity;
}

// Căn chỉnh coarse-to-fine → shift ở thang tầng l0
function alignPyr(refPyr, candPyr) {
  let dx = 0, dy = 0, best = 0;
  for (let lvl = 2; lvl >= 0; lvl--) {
    dx *= 2; dy *= 2;
    const range = lvl === 2 ? 4 : 1;
    best = Infinity; let bdx = dx, bdy = dy;
    for (let oy = -range; oy <= range; oy++) {
      for (let ox = -range; ox <= range; ox++) {
        const s = sad(refPyr[lvl], candPyr[lvl], dx + ox, dy + oy);
        if (s < best) { best = s; bdx = dx + ox; bdy = dy + oy; }
      }
    }
    dx = bdx; dy = bdy;
  }
  return { dx, dy, sad: best };
}

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// =========================================================
// ALIGN + MERGE (Night v2)
// =========================================================
export function alignAndMerge(imageDatas) {
  const n = imageDatas.length;
  const first = imageDatas[0];
  const W = first.width, H = first.height;
  if (n === 1) return postProcessNight(cloneImageData(first));

  const pyrs = imageDatas.map((im) => pyramid(im, W, H));
  const scale = pyrs[0][3];

  // Frame tham chiếu = nét nhất (lapVar lớn nhất trên tầng nhỏ)
  let refIdx = 0, bestSharp = -1;
  for (let i = 0; i < n; i++) {
    const s = lapVar(pyrs[i][2]);
    if (s > bestSharp) { bestSharp = s; refIdx = i; }
  }

  const refPyr = pyrs[refIdx];
  const shifts = new Array(n);
  const sads = [];
  for (let i = 0; i < n; i++) {
    if (i === refIdx) { shifts[i] = { dx: 0, dy: 0, sad: 0 }; continue; }
    const a = alignPyr(refPyr, pyrs[i]);
    shifts[i] = { dx: a.dx * scale, dy: a.dy * scale, sad: a.sad };
    sads.push(a.sad);
  }
  // Loại frame chuyển động/che khuất nặng: SAD > 1.5× median
  const med = median(sads);
  const use = new Array(n).fill(true);
  for (let i = 0; i < n; i++) {
    if (i !== refIdx && med > 0 && shifts[i].sad > 1.5 * med) use[i] = false;
  }

  // Merge bền vững: w = 1/(1+(d/σ)²), σ = max(8, noiseScale·√r)
  const ref = imageDatas[refIdx].data;
  const out = new ImageData(W, H);
  const o = out.data;
  const noiseScale = 1.2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const r = ref[p + ch];
        const sigma = Math.max(8, noiseScale * Math.sqrt(r));
        let acc = r, wsum = 1;
        for (let i = 0; i < n; i++) {
          if (i === refIdx || !use[i]) continue;
          const sx = x + shifts[i].dx, sy = y + shifts[i].dy;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const v = imageDatas[i].data[(sy * W + sx) * 4 + ch];
          const dd = (v - r) / sigma;
          const wgt = 1 / (1 + dd * dd);
          acc += wgt * v; wsum += wgt;
        }
        o[p + ch] = acc / wsum;
      }
      o[p + 3] = 255;
    }
  }
  return postProcessNight(out);
}

// -------- Hậu kỳ đêm --------
function postProcessNight(img) {
  const w = img.width, h = img.height;
  chromaDenoise(img, w, h, 2);
  gamma(img, 0.72);
  autoLevelsHi(img);                 // bảo vệ highlight (không kéo hi < 240)
  unsharpMaskData(img, w, h, 0.35, 1);
  return img;
}

// Khử nhiễu chroma: YCbCr, blur radius 2 CHỈ trên Cb/Cr, chuyển lại RGB
function chromaDenoise(img, w, h, r) {
  const d = img.data, N = w * h;
  const Y = new Float32Array(N);
  const Cb = new Uint8ClampedArray(N);
  const Cr = new Uint8ClampedArray(N);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    Y[p] = 0.299 * R + 0.587 * G + 0.114 * B;
    Cb[p] = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
    Cr[p] = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
  }
  const Cb2 = blurAlpha(Cb, w, h, r);
  const Cr2 = blurAlpha(Cr, w, h, r);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const y = Y[p], cb = Cb2[p] - 128, cr = Cr2[p] - 128;
    d[i]     = y + 1.402 * cr;
    d[i + 1] = y - 0.344136 * cb - 0.714136 * cr;
    d[i + 2] = y + 1.772 * cb;
  }
}

// auto-levels bảo vệ highlight
function autoLevelsHi(img) {
  const d = img.data, n = d.length / 4;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    hist[l]++;
  }
  const clip = n * 0.005;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > clip) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > clip) { hi = i; break; } }
  if (hi < 240) hi = 240; // không kéo highlight xuống để đèn không cháy
  if (hi <= lo) return img;
  const scale = 255 / (hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.min(255, Math.max(0, (i - lo) * scale));
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  return img;
}

function cloneImageData(img) {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

// =========================================================
// HDR — exposure fusion kiểu Mertens (căn về EV0 giữa)
// trọng số = well-exposedness × contrast cục bộ (blur nhẹ trên weight map)
// =========================================================
export function exposureFusion(imageDatas) {
  const n = imageDatas.length;
  const W = imageDatas[0].width, H = imageDatas[0].height;
  const N = W * H;
  const refIdx = Math.floor(n / 2); // mảng [EV-1, EV0, EV+1] → giữa

  const pyrs = imageDatas.map((im) => pyramid(im, W, H));
  const scale = pyrs[0][3];
  const shifts = imageDatas.map((im, i) => {
    if (i === refIdx) return { dx: 0, dy: 0 };
    const a = alignPyr(pyrs[refIdx], pyrs[i]);
    return { dx: a.dx * scale, dy: a.dy * scale };
  });

  // luma đã căn chỉnh + weight map mỗi frame
  const weights = [];
  const lumas = [];
  for (let i = 0; i < n; i++) {
    const l = new Float32Array(N);
    const d = imageDatas[i].data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = x + shifts[i].dx, sy = y + shifts[i].dy;
        let li = 0;
        if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
          const q = (sy * W + sx) * 4;
          li = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
        }
        l[y * W + x] = li;
      }
    }
    lumas.push(l);
  }
  for (let i = 0; i < n; i++) {
    const l = lumas[i];
    const c = new Uint8ClampedArray(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : x, xp = x < W - 1 ? x + 1 : x;
        const ym = y > 0 ? y - 1 : y, yp = y < H - 1 ? y + 1 : y;
        const lap = Math.abs(4 * l[y * W + x] - l[y * W + xm] - l[y * W + xp] - l[ym * W + x] - l[yp * W + x]);
        c[y * W + x] = Math.min(255, lap);
      }
    }
    const cb = blurAlpha(c, W, H, 8); // làm mềm weight map (bỏ multi-band pyramid)
    const w = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const ln = l[p] / 255;
      const we = Math.exp(-((ln - 0.5) * (ln - 0.5)) / 0.08); // well-exposedness
      w[p] = we * (cb[p] / 255 + 0.02);
    }
    weights.push(w);
  }

  const out = new ImageData(W, H);
  const o = out.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let wsum = 0;
      for (let i = 0; i < n; i++) wsum += weights[i][p];
      if (wsum <= 0) wsum = 1;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < n; i++) {
        const wt = weights[i][p] / wsum;
        if (wt <= 0) continue;
        const sx = x + shifts[i].dx, sy = y + shifts[i].dy;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const d = imageDatas[i].data, q = (sy * W + sx) * 4;
        r += wt * d[q]; g += wt * d[q + 1]; b += wt * d[q + 2];
      }
      const q = p * 4;
      o[q] = r; o[q + 1] = g; o[q + 2] = b; o[q + 3] = 255;
    }
  }
  unsharpMaskData(out, W, H, 0.3, 1);
  return out;
}
