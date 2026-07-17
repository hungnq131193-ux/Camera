/* =========================================================
 * enhance-core.js — LÕI xử lý ảnh THUẦN PIXEL (không DOM, không import)
 * Dùng chung cho main-thread wrapper (enhance.js) và Web Worker
 * (worker/enhance-worker.js). TUYỆT ĐỐI không import state.js hay
 * chạm document/localStorage — nếu không sẽ throw trong worker.
 *
 * Tất cả hàm nhận/trả ImageData (hoặc mutate tại chỗ) — không nhận ctx.
 * ========================================================= */

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

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
    const sat = (max - min) / 255;
    const skin = r > 95 && r > g && g > b && (r - b) > 15;
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
    d[i] = Math.min(255, d[i] * (1 + amount));
    d[i + 2] = Math.max(0, d[i + 2] * (1 - amount * 0.6));
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

// =========================================================
// BOX BLUR nhanh (separable, sliding-window O(w·h) — không phụ thuộc bán kính)
// Cùng ngữ nghĩa clamp biên như blurAlpha để output khớp bản cũ.
// Sanity: blur ảnh hằng số → chính nó.
// =========================================================
export function boxBlur(img, w, h, radius) {
  if (radius < 1) return img;
  const out = new ImageData(new Uint8ClampedArray(img.data), w, h);
  const tmp = new Uint8ClampedArray(img.data.length);
  const r = Math.round(radius);
  blurPass(img.data, tmp, w, h, r, true);   // ngang
  blurPass(tmp, out.data, w, h, r, false);  // dọc
  return out;
}

// 1 pass sliding-window trên 4 kênh RGBA (accumulator chạy song song)
function blurPass(src, dst, w, h, r, horizontal) {
  const div = r * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = -r; k <= r; k++) {
        const sx = k < 0 ? 0 : (k >= w ? w - 1 : k);
        const idx = (row + sx) * 4;
        s0 += src[idx]; s1 += src[idx + 1]; s2 += src[idx + 2]; s3 += src[idx + 3];
      }
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        dst[o] = s0 / div; dst[o + 1] = s1 / div; dst[o + 2] = s2 / div; dst[o + 3] = s3 / div;
        const addX = x + r + 1 >= w ? w - 1 : x + r + 1;
        const subX = x - r <= 0 ? 0 : x - r;
        const ai = (row + addX) * 4, si = (row + subX) * 4;
        s0 += src[ai] - src[si];
        s1 += src[ai + 1] - src[si + 1];
        s2 += src[ai + 2] - src[si + 2];
        s3 += src[ai + 3] - src[si + 3];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = -r; k <= r; k++) {
        const sy = k < 0 ? 0 : (k >= h ? h - 1 : k);
        const idx = (sy * w + x) * 4;
        s0 += src[idx]; s1 += src[idx + 1]; s2 += src[idx + 2]; s3 += src[idx + 3];
      }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        dst[o] = s0 / div; dst[o + 1] = s1 / div; dst[o + 2] = s2 / div; dst[o + 3] = s3 / div;
        const addY = y + r + 1 >= h ? h - 1 : y + r + 1;
        const subY = y - r <= 0 ? 0 : y - r;
        const ai = (addY * w + x) * 4, si = (subY * w + x) * 4;
        s0 += src[ai] - src[si];
        s1 += src[ai + 1] - src[si + 1];
        s2 += src[ai + 2] - src[si + 2];
        s3 += src[ai + 3] - src[si + 3];
      }
    }
  }
}

// ---------- UNSHARP MASK (làm nét) — nhận/trả ImageData ----------
export function unsharpMaskData(img, w, h, amount = 0.4, radius = 1) {
  const blurred = boxBlur(img, w, h, radius);
  const d = img.data, b = blurred.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255(d[i] + (d[i] - b[i]) * amount);
    d[i + 1] = clamp255(d[i + 1] + (d[i + 1] - b[i + 1]) * amount);
    d[i + 2] = clamp255(d[i + 2] + (d[i + 2] - b[i + 2]) * amount);
  }
  return img;
}

// =========================================================
// AUTO-ENHANCE tổng hợp trên MỘT ImageData duy nhất
// autoLevels → grayWorldWB → vibrance → unsharp
// (caller chỉ getImageData/putImageData 1 lần)
// =========================================================
export function autoEnhanceData(img, w, h) {
  autoLevels(img);
  grayWorldWB(img);
  vibrance(img, 0.35);
  unsharpMaskData(img, w, h, 0.4, 1);
  return img;
}

// =========================================================
// XOÁ PHÔNG CHÂN DUNG (bokeh) — nhận/trả ImageData
// mask: Uint8Array (0 = nền, khác 0 = người, HOẶC alpha mềm 0..255)
// =========================================================
export function portraitBokehData(img, w, h, mask, maskW, maskH, blurRadius = 14, softMask = false) {
  const blurred = boxBlur(img, w, h, Math.max(2, blurRadius));
  const alpha = buildPersonAlpha(mask, maskW, maskH, w, h, softMask);
  const d = img.data, bd = blurred.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = alpha[p] / 255; // 1 = người (nét), 0 = nền (mờ)
    d[i]     = d[i] * a + bd[i] * (1 - a);
    d[i + 1] = d[i + 1] * a + bd[i + 1] * (1 - a);
    d[i + 2] = d[i + 2] * a + bd[i + 2] * (1 - a);
    d[i + 3] = 255;
  }
  // Làm mịn da nhẹ trong vùng người
  skinSmoothData(img, w, h, alpha);
  return img;
}

// Dựng alpha người (0..255) từ mask + feather biên.
// softMask=false → nhị phân hoá (mask != 0 → 255), feather rộng.
// softMask=true  → dùng mask như xác suất 0..255 (Phase B), feather NỬA bán kính.
export function buildPersonAlpha(mask, mw, mh, w, h, softMask = false) {
  const raw = new Uint8ClampedArray(w * h);
  if (softMask) {
    // Upscale bilinear mask mềm 0..255
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) * mh / h - 0.5;
      let y0 = Math.floor(fy); const wy = fy - y0;
      if (y0 < 0) y0 = 0; let y1 = y0 + 1; if (y1 >= mh) y1 = mh - 1;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) * mw / w - 0.5;
        let x0 = Math.floor(fx); const wx = fx - x0;
        if (x0 < 0) x0 = 0; let x1 = x0 + 1; if (x1 >= mw) x1 = mw - 1;
        const a = mask[y0 * mw + x0], b = mask[y0 * mw + x1];
        const c = mask[y1 * mw + x0], e = mask[y1 * mw + x1];
        const top = a + (b - a) * wx, bot = c + (e - c) * wx;
        raw[y * w + x] = top + (bot - top) * wy;
      }
    }
  } else {
    // Nhị phân hoá theo mask, scale nearest
    for (let y = 0; y < h; y++) {
      const my = (y * mh / h) | 0;
      for (let x = 0; x < w; x++) {
        const mx = (x * mw / w) | 0;
        raw[y * w + x] = mask[my * mw + mx] ? 255 : 0;
      }
    }
  }
  // feather biên: blur alpha. softMask đã mềm sẵn → feather nửa bán kính.
  let featherR = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  if (softMask) featherR = Math.max(1, Math.round(featherR / 2));
  return blurAlpha(raw, w, h, featherR);
}

// Blur 1 kênh alpha (sliding-window O(w·h))
export function blurAlpha(a, w, h, r) {
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

// Làm mịn da: blur nhẹ rồi trộn lại chỉ ở vùng alpha (người) — nhận/trả ImageData
export function skinSmoothData(img, w, h, alpha) {
  const soft = boxBlur(img, w, h, Math.max(1, Math.round(Math.min(w, h) * 0.004)));
  const d = img.data, s = soft.data;
  const strength = 0.35;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = (alpha[p] / 255) * strength;
    d[i]     = d[i] * (1 - a) + s[i] * a;
    d[i + 1] = d[i + 1] * (1 - a) + s[i + 1] * a;
    d[i + 2] = d[i + 2] * (1 - a) + s[i + 2] * a;
  }
  return img;
}

// =========================================================
// CHẾ ĐỘ ĐÊM — stacking nhiều frame (cộng trung bình) + nâng sáng
// imageDatas: mảng ImageData cùng kích thước → trả ImageData kết quả
// (Phase A: cộng trung bình ngây thơ; Phase C thay bằng align+merge)
// =========================================================
export function stackFramesData(imageDatas) {
  const first = imageDatas[0];
  const w = first.width, h = first.height;
  const acc = new Float32Array(w * h * 4);
  for (const im of imageDatas) {
    const d = im.data;
    for (let i = 0; i < d.length; i++) acc[i] += d[i];
  }
  const out = new ImageData(w, h);
  const o = out.data, n = imageDatas.length;
  for (let i = 0; i < o.length; i++) o[i] = acc[i] / n;

  // Nâng sáng bằng gamma + auto-levels + unsharp
  gamma(out, 0.72);
  autoLevels(out);
  unsharpMaskData(out, w, h, 0.35, 1);
  return out;
}
