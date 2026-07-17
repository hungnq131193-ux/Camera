/* =========================================================
 * enhance.js — Xử lý ảnh sau chụp (thuần ImageData/canvas)
 * auto-levels, gray-world WB, vibrance, unsharp mask,
 * filter màu (Món ăn/Phong cảnh), bokeh chân dung, stacking đêm.
 * ========================================================= */
import { store } from "./state.js";

const MAX_EDGE = 4096; // downscale cạnh dài trước khi xử lý nặng

// ---------- Tiện ích canvas ----------
export function canvasFrom(source, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (source) ctx.drawImage(source, 0, 0, w, h);
  return { c, ctx };
}

// Downscale nếu quá lớn (giữ tỉ lệ)
export function limitSize(bitmap) {
  let w = bitmap.width, h = bitmap.height;
  const edge = Math.max(w, h);
  if (edge > MAX_EDGE) {
    const s = MAX_EDGE / edge;
    w = Math.round(w * s); h = Math.round(h * s);
  }
  return canvasFrom(bitmap, w, h);
}

// Crop canvas theo tỉ lệ khung (giữ giữa)
export function cropAspect(c, aspect) {
  if (!aspect || aspect === "full") return c;
  const map = { "4:3": 4 / 3, "16:9": 16 / 9, "1:1": 1 }; // rộng:cao khi ngang;
  // Ảnh chụp thường ngang (sensor). Áp tỉ lệ dọc cho khớp preview dọc:
  // ta crop sao cho (h/w) = map (khung dọc). map ở đây là cao/rộng.
  const targetRatio = { "4:3": 4 / 3, "16:9": 16 / 9, "1:1": 1 }[aspect];
  const W = c.width, H = c.height;
  // Ảnh có thể ngang hoặc dọc; crop về khung dọc tỉ lệ (rộng : cao) = 3:4 ...
  // targetHW = cao/rộng
  let cw = W, ch = H;
  if (H / W > targetRatio) {
    // quá cao → cắt bớt cao
    ch = Math.round(W * targetRatio);
  } else {
    // quá rộng → cắt bớt rộng
    cw = Math.round(H / targetRatio);
  }
  const ox = Math.round((W - cw) / 2), oy = Math.round((H - ch) / 2);
  const { c: out, ctx } = canvasFrom(null, cw, ch);
  ctx.drawImage(c, ox, oy, cw, ch, 0, 0, cw, ch);
  return out;
}

// Lật gương (selfie)
export function mirror(c) {
  const { c: out, ctx } = canvasFrom(null, c.width, c.height);
  ctx.translate(c.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(c, 0, 0);
  return out;
}

// ---------- AUTO-LEVELS (kéo giãn histogram, cắt 0.5%) ----------
export function autoLevels(img) {
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
  if (hi <= lo) return img;
  const scale = 255 / (hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.min(255, Math.max(0, (i - lo) * scale));
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  return img;
}

// ---------- WHITE BALANCE gray-world ----------
export function grayWorldWB(img) {
  const d = img.data;
  let rs = 0, gs = 0, bs = 0, n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; }
  const ra = rs / n, ga = gs / n, ba = bs / n;
  const gray = (ra + ga + ba) / 3;
  const kr = ra ? gray / ra : 1, kg = ga ? gray / ga : 1, kb = ba ? gray / ba : 1;
  // kẹp hệ số để không quá tay
  const cl = (k) => Math.min(1.4, Math.max(0.7, k));
  const cr = cl(kr), cg = cl(kg), cb = cl(kb);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] * cr);
    d[i + 1] = Math.min(255, d[i + 1] * cg);
    d[i + 2] = Math.min(255, d[i + 2] * cb);
  }
  return img;
}

// ---------- VIBRANCE (tăng bão hoà vùng nhạt, giữ da) ----------
export function vibrance(img, amount = 0.35) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = (max - min) / 255;           // độ bão hoà hiện tại
    const skin = r > 95 && r > g && g > b && (r - b) > 15; // heuristic màu da
    const boost = amount * (1 - sat) * (skin ? 0.4 : 1);
    const avg = (r + g + b) / 3;
    d[i] = Math.min(255, r + (r - avg) * boost);
    d[i + 1] = Math.min(255, g + (g - avg) * boost);
    d[i + 2] = Math.min(255, b + (b - avg) * boost);
  }
  return img;
}

// ---------- CONTRAST / SATURATION đơn giản ----------
export function contrast(img, amount = 0.1) {
  const d = img.data, f = (1 + amount);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, Math.max(0, (d[i] - 128) * f + 128));
    d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 128) * f + 128));
    d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 128) * f + 128));
  }
  return img;
}

export function saturation(img, amount = 0.2) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = Math.min(255, Math.max(0, gray + (r - gray) * (1 + amount)));
    d[i + 1] = Math.min(255, Math.max(0, gray + (g - gray) * (1 + amount)));
    d[i + 2] = Math.min(255, Math.max(0, gray + (b - gray) * (1 + amount)));
  }
  return img;
}

// Tone ấm (Món ăn)
export function warmTone(img, amount = 0.12) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] * (1 + amount));       // + đỏ
    d[i + 2] = Math.max(0, d[i + 2] * (1 - amount * 0.6)); // - xanh
  }
  return img;
}

// Gamma / nâng sáng (Đêm)
export function gamma(img, g = 0.8) {
  const d = img.data;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.min(255, 255 * Math.pow(i / 255, g));
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  return img;
}

// ---------- UNSHARP MASK (làm nét) ----------
export function unsharpMask(ctx, w, h, amount = 0.4, radius = 1) {
  const src = ctx.getImageData(0, 0, w, h);
  const blurred = boxBlur(src, w, h, radius);
  const d = src.data, b = blurred.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255(d[i] + (d[i] - b[i]) * amount);
    d[i + 1] = clamp255(d[i + 1] + (d[i + 1] - b[i + 1]) * amount);
    d[i + 2] = clamp255(d[i + 2] + (d[i + 2] - b[i + 2]) * amount);
  }
  ctx.putImageData(src, 0, 0);
}

// ---------- Box blur nhanh (separable) ----------
export function boxBlur(img, w, h, radius) {
  if (radius < 1) return img;
  const out = new ImageData(new Uint8ClampedArray(img.data), w, h);
  const tmp = new Uint8ClampedArray(img.data.length);
  const r = Math.round(radius);
  // ngang
  blurPass(img.data, tmp, w, h, r, true);
  // dọc
  blurPass(tmp, out.data, w, h, r, false);
  return out;
}
function blurPass(src, dst, w, h, r, horizontal) {
  const div = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0, cnt = 0;
      for (let k = -r; k <= r; k++) {
        let sx = x, sy = y;
        if (horizontal) sx = Math.min(w - 1, Math.max(0, x + k));
        else sy = Math.min(h - 1, Math.max(0, y + k));
        const idx = (sy * w + sx) * 4;
        ar += src[idx]; ag += src[idx + 1]; ab += src[idx + 2]; aa += src[idx + 3]; cnt++;
      }
      const o = (y * w + x) * 4;
      dst[o] = ar / cnt; dst[o + 1] = ag / cnt; dst[o + 2] = ab / cnt; dst[o + 3] = aa / cnt;
    }
  }
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// ---------- Vignette (Món ăn) ----------
export function vignette(ctx, w, h, strength = 0.35) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// =========================================================
// AUTO-ENHANCE tổng hợp (dùng cho hầu hết mode nếu bật setting)
// =========================================================
export function autoEnhance(c) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let img = ctx.getImageData(0, 0, c.width, c.height);
  autoLevels(img);
  grayWorldWB(img);
  vibrance(img, 0.35);
  ctx.putImageData(img, 0, 0);
  unsharpMask(ctx, c.width, c.height, 0.4, 1);
  return c;
}

// =========================================================
// FILTER MÀU theo mode (khớp preview CSS filter)
// =========================================================
export function applyModeFilter(c, mode) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let img = ctx.getImageData(0, 0, c.width, c.height);
  if (mode === "food") {
    warmTone(img, 0.1);
    saturation(img, 0.22);
    ctx.putImageData(img, 0, 0);
    vignette(ctx, c.width, c.height, 0.3);
  } else if (mode === "landscape") {
    autoLevels(img);
    saturation(img, 0.25);
    contrast(img, 0.12);
    ctx.putImageData(img, 0, 0);
    unsharpMask(ctx, c.width, c.height, 0.3, 1);
  } else {
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

// CSS filter tương ứng cho preview realtime
export const PREVIEW_FILTERS = {
  food: "saturate(1.22) contrast(1.05) brightness(1.03) sepia(0.06)",
  landscape: "saturate(1.25) contrast(1.1)",
  night: "brightness(1.15)",
  photo: "none",
  portrait: "none",
  pro: "none",
  video: "none",
};

// =========================================================
// XOÁ PHÔNG CHÂN DUNG (bokeh) dùng category mask từ segmenter
// mask: Uint8Array (0 = nền, khác 0 = người) kích thước maskW×maskH
// =========================================================
export function portraitBokeh(c, mask, maskW, maskH, blurRadius = 14) {
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const orig = ctx.getImageData(0, 0, w, h);

  // Nền mờ
  const blurredData = boxBlur(orig, w, h, Math.max(2, blurRadius));

  // Alpha người theo mask (scale mask → kích thước ảnh), feather biên bằng blur mask
  const alpha = buildPersonAlpha(mask, maskW, maskH, w, h);

  const out = ctx.createImageData(w, h);
  const o = out.data, od = orig.data, bd = blurredData.data;
  for (let i = 0, p = 0; i < o.length; i += 4, p++) {
    const a = alpha[p] / 255; // 1 = người (nét), 0 = nền (mờ)
    o[i]     = od[i] * a + bd[i] * (1 - a);
    o[i + 1] = od[i + 1] * a + bd[i + 1] * (1 - a);
    o[i + 2] = od[i + 2] * a + bd[i + 2] * (1 - a);
    o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);

  // Làm mịn da nhẹ trong vùng người
  skinSmooth(c, alpha);
  return c;
}

// Dựng alpha người (0..255) từ category mask + feather biên
function buildPersonAlpha(mask, mw, mh, w, h) {
  // 1) nhị phân hoá theo mask, scale bằng nearest
  const raw = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const my = (y * mh / h) | 0;
    for (let x = 0; x < w; x++) {
      const mx = (x * mw / w) | 0;
      raw[y * w + x] = mask[my * mw + mx] ? 255 : 0;
    }
  }
  // 2) feather biên: blur alpha (chuyển sang ImageData 1 kênh giả)
  const featherR = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  return blurAlpha(raw, w, h, featherR);
}

function blurAlpha(a, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const div = r * 2 + 1;
  // ngang
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / div;
      const add = a[y * w + Math.min(w - 1, x + r + 1)];
      const sub = a[y * w + Math.max(0, x - r)];
      sum += add - sub;
    }
  }
  // dọc
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / div;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      sum += add - sub;
    }
  }
  return out;
}

// Làm mịn da: blur nhẹ rồi trộn lại chỉ ở vùng alpha (người)
function skinSmooth(c, alpha) {
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const soft = boxBlur(img, w, h, Math.max(1, Math.round(Math.min(w, h) * 0.004)));
  const d = img.data, s = soft.data;
  const strength = 0.35;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = (alpha[p] / 255) * strength;
    d[i]     = d[i] * (1 - a) + s[i] * a;
    d[i + 1] = d[i + 1] * (1 - a) + s[i + 1] * a;
    d[i + 2] = d[i + 2] * (1 - a) + s[i + 2] * a;
  }
  ctx.putImageData(img, 0, 0);
}

// =========================================================
// CHẾ ĐỘ ĐÊM — stacking nhiều frame (cộng trung bình) + nâng sáng
// frames: mảng canvas cùng kích thước
// =========================================================
export function stackFrames(frames) {
  const w = frames[0].width, h = frames[0].height;
  const acc = new Float32Array(w * h * 4);
  const ctxs = frames.map(f => f.getContext("2d", { willReadFrequently: true }));
  for (const ctx of ctxs) {
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i++) acc[i] += d[i];
  }
  const { c: out, ctx } = canvasFrom(null, w, h);
  const img = ctx.createImageData(w, h);
  const o = img.data, n = frames.length;
  for (let i = 0; i < o.length; i++) o[i] = acc[i] / n;
  ctx.putImageData(img, 0, 0);

  // Nâng sáng bằng gamma + auto-levels + unsharp
  let d2 = ctx.getImageData(0, 0, w, h);
  gamma(d2, 0.72);
  autoLevels(d2);
  ctx.putImageData(d2, 0, 0);
  unsharpMask(ctx, w, h, 0.35, 1);
  return out;
}
