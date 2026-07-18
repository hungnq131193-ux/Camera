/* =========================================================
 * enhance.js — Helper phụ thuộc DOM + wrapper main-thread (FALLBACK)
 * Lõi pixel thuần nằm ở enhance-core.js (dùng chung với Web Worker).
 * Các wrapper ở đây là đường fallback cho trình duyệt KHÔNG hỗ trợ
 * module worker / OffscreenCanvas.
 * ========================================================= */
import {
  autoLevels, grayWorldWB, vibrance, contrast, saturation, warmTone,
  gamma, boxBlur, unsharpMaskData, autoEnhanceData, portraitBokehData,
  stackFramesData,
} from "./enhance-core.js";

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
  const targetRatio = { "4:3": 4 / 3, "16:9": 16 / 9, "1:1": 1 }[aspect];
  if (!targetRatio) return c;
  const W = c.width, H = c.height;
  let cw = W, ch = H;
  if (H / W > targetRatio) {
    ch = Math.round(W * targetRatio);
  } else {
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

// ---------- Vignette (Món ăn) — gradient 2D trên canvas ----------
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
// WRAPPER MAIN-THREAD (fallback) — get/putImageData quanh lõi
// =========================================================
export function autoEnhance(c) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  autoEnhanceData(img, c.width, c.height);
  ctx.putImageData(img, 0, 0);
  return c;
}

export function applyModeFilter(c, mode) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  if (mode === "food") {
    warmTone(img, 0.1);
    saturation(img, 0.22);
    ctx.putImageData(img, 0, 0);
    vignette(ctx, c.width, c.height, 0.3);
  } else if (mode === "landscape") {
    autoLevels(img);
    saturation(img, 0.25);
    contrast(img, 0.12);
    unsharpMaskData(img, c.width, c.height, 0.3, 1);
    ctx.putImageData(img, 0, 0);
  } else {
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

// Xoá phông chân dung (fallback)
export function portraitBokeh(c, mask, maskW, maskH, blurRadius = 14, softMask = false) {
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  portraitBokehData(img, w, h, mask, maskW, maskH, blurRadius, softMask);
  ctx.putImageData(img, 0, 0);
  return c;
}

// Stacking đêm (fallback) — frames: mảng canvas cùng kích thước → canvas
export function stackFrames(frames) {
  const w = frames[0].width, h = frames[0].height;
  const imageDatas = frames.map(f => {
    const cx = f.getContext("2d", { willReadFrequently: true });
    return cx.getImageData(0, 0, w, h);
  });
  const merged = stackFramesData(imageDatas);
  const { c: out, ctx } = canvasFrom(null, w, h);
  ctx.putImageData(merged, 0, 0);
  return out;
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

// Re-export vài hàm lõi để module khác vẫn import từ đây nếu cần
export { boxBlur, gamma, unsharpMaskData };
