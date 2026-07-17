/* =========================================================
 * enhance-worker.js — Pipeline xử lý ảnh OFF-MAIN-THREAD (module worker)
 * Nhận ImageBitmap đã có hình học cuối (crop/mirror/downscale xong) →
 * OffscreenCanvas → 1 lần getImageData → chain hàm lõi → putImageData →
 * convertToBlob JPEG + thumb 256px. Xử lý job tuần tự (message queue).
 *
 * Ghi chú WebGL2 (C4): sau khi blur đã O(n) + offload sang worker, chi phí
 * CPU còn lại người dùng không cảm nhận. WebGL2 thêm shader + xử lý
 * context-loss + pipeline thứ 2 phải giữ parity — không đáng cho độ trễ
 * đã vô hình. Chỉ xem lại nếu job worker > 4s trên Android yếu.
 * ========================================================= */
import * as core from "../enhance-core.js";

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.kind === "ping") { self.postMessage({ kind: "pong" }); return; }

  try {
    let result;
    if (msg.kind === "photo") result = await processPhoto(msg);
    else if (msg.kind === "night") result = await processNight(msg);
    else if (msg.kind === "hdr") result = await processHdr(msg);
    else throw new Error("Loại job không hỗ trợ: " + msg.kind);
    self.postMessage({ id: msg.id, ok: true, ...result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};

// -------- Tạo thumbnail 256px center-crop từ 1 canvas nguồn --------
async function makeThumbBlob(srcCanvas, w, h) {
  const size = 256;
  const scale = size / Math.min(w, h);
  const tc = new OffscreenCanvas(size, size);
  const ctx = tc.getContext("2d");
  const dw = w * scale, dh = h * scale;
  ctx.drawImage(srcCanvas, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return await tc.convertToBlob({ type: "image/jpeg", quality: 0.8 });
}

// Vignette gradient 2D (Món ăn) — cùng công thức enhance.js
function drawVignette(ctx, w, h, strength = 0.35) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// =========================================================
// PHOTO — 1 ảnh (photo/landscape/food/portrait)
// =========================================================
async function processPhoto(msg) {
  const { bitmap, mode, autoEnhance, jpegQuality, mask, portraitBlur } = msg;
  const w = bitmap.width, h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();

  let img = ctx.getImageData(0, 0, w, h);

  if (mode === "portrait" && mask) {
    const maskArr = new Uint8Array(mask.buf);
    core.portraitBokehData(img, w, h, maskArr, mask.w, mask.h, portraitBlur, !!mask.soft);
    if (autoEnhance) core.autoEnhanceData(img, w, h);
    ctx.putImageData(img, 0, 0);
  } else if (mode === "food") {
    // Giữ đúng thứ tự sync: warm/sat → vignette → autoEnhance
    core.warmTone(img, 0.1);
    core.saturation(img, 0.22);
    ctx.putImageData(img, 0, 0);
    drawVignette(ctx, w, h, 0.3);
    img = ctx.getImageData(0, 0, w, h);
    if (autoEnhance) core.autoEnhanceData(img, w, h);
    ctx.putImageData(img, 0, 0);
  } else if (mode === "landscape") {
    core.autoLevels(img);
    core.saturation(img, 0.25);
    core.contrast(img, 0.12);
    core.unsharpMaskData(img, w, h, 0.3, 1);
    if (autoEnhance) core.autoEnhanceData(img, w, h);
    ctx.putImageData(img, 0, 0);
  } else {
    // photo (mặc định)
    if (autoEnhance) core.autoEnhanceData(img, w, h);
    ctx.putImageData(img, 0, 0);
  }

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: jpegQuality });
  const thumbBlob = await makeThumbBlob(canvas, w, h);
  return { blob, thumbBlob, width: w, height: h };
}

// =========================================================
// NIGHT — burst stacking (Phase A: cộng trung bình; Phase C: align+merge)
// =========================================================
async function processNight(msg) {
  const { bitmaps, jpegQuality, autoEnhance } = msg;
  const first = bitmaps[0];
  const w = first.width, h = first.height;

  const imageDatas = bitmaps.map((bm) => {
    const c = new OffscreenCanvas(w, h);
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bm, 0, 0, w, h);
    if (bm.close) bm.close();
    return cx.getImageData(0, 0, w, h);
  });

  // Phase A: cộng trung bình ngây thơ. Phase C thay bằng align+merge (night.js).
  const merged = core.stackFramesData(imageDatas);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.putImageData(merged, 0, 0);

  if (autoEnhance) {
    const img = ctx.getImageData(0, 0, w, h);
    core.autoEnhanceData(img, w, h);
    ctx.putImageData(img, 0, 0);
  }

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: jpegQuality });
  const thumbBlob = await makeThumbBlob(canvas, w, h);
  return { blob, thumbBlob, width: w, height: h };
}

// =========================================================
// HDR — exposure fusion (Phase C). Fallback: coi như night stacking.
// =========================================================
async function processHdr(msg) {
  const { bitmaps, jpegQuality } = msg;
  const first = bitmaps[0];
  const w = first.width, h = first.height;

  const imageDatas = bitmaps.map((bm) => {
    const c = new OffscreenCanvas(w, h);
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bm, 0, 0, w, h);
    if (bm.close) bm.close();
    return cx.getImageData(0, 0, w, h);
  });

  // Phase C sẽ thay bằng exposure fusion (night.js).
  const fused = core.stackFramesData(imageDatas);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(fused, 0, 0);

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: jpegQuality });
  const thumbBlob = await makeThumbBlob(canvas, w, h);
  return { blob, thumbBlob, width: w, height: h };
}
