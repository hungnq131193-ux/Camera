/* =========================================================
 * capture.js — Pipeline chụp ảnh
 * Đường nhanh (worker): quick-save bản JPEG đúng hình học NGAY, mở khoá
 * nút chụp, rồi worker enhance nền → updateMedia đè cùng record. Auto-download
 * bản cuối. Đường fallback: capturePhotoSync (đồng bộ như bản cũ).
 * ========================================================= */
import { store } from "./state.js";
import { getMode } from "./modes.js";
import { flashPulse } from "./camera.js";
import { initSegmenter } from "./ai.js";
import { saveMedia, updateMedia } from "./gallery.js";
import * as pipeline from "./pipeline.js";
import { maybeAutoDownload } from "./download.js";
import {
  limitSize, cropAspect, mirror, autoEnhance,
  applyModeFilter, portraitBokeh, stackFrames, canvasFrom,
} from "./enhance.js";

// -------- Âm chụp (WebAudio) --------
let audioCtx = null;
function shutterSound() {
  if (!store.settings.shutterSound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1100, t);
    osc.frequency.exponentialRampToValueAtTime(500, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.1);
  } catch {}
}

export function doFlash() {
  const flash = store.el.flash;
  flash.classList.add("active");
  requestAnimationFrame(() => flash.classList.remove("active"));
}

// -------- Lấy 1 frame full-res (ImageCapture → fallback canvas) --------
async function grabFullFrame() {
  const track = store.videoTrack;
  const video = store.el.video;
  if (store.imageCapture) {
    try {
      let photoSettings = {};
      try {
        const pc = await store.imageCapture.getPhotoCapabilities();
        if (pc && pc.imageWidth && pc.imageWidth.max) {
          photoSettings = { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight ? pc.imageHeight.max : undefined };
        }
      } catch {}
      const blob = await store.imageCapture.takePhoto(photoSettings);
      return await createImageBitmap(blob);
    } catch (err) {
      console.warn("takePhoto lỗi, fallback canvas:", err);
    }
  }
  const s = track && track.getSettings ? track.getSettings() : {};
  const w = s.width || video.videoWidth || 1920;
  const h = s.height || video.videoHeight || 1080;
  const { c } = canvasFrom(video, w, h);
  return await createImageBitmap(c);
}

// Vẽ 1 frame video → canvas hình học cuối (crop tỉ lệ + mirror selfie)
function frameToFinalCanvas() {
  const video = store.el.video;
  const w = video.videoWidth, h = video.videoHeight;
  let c = canvasFrom(video, w, h).c;
  c = cropAspect(c, store.aspect);
  if (store.currentFacing === "user" && store.settings.mirrorSelfie) c = mirror(c);
  return c;
}

// Thumbnail 256px center-crop từ canvas (đường nhanh) → Blob
function makeQuickThumb(c) {
  const size = 256;
  const w = c.width, h = c.height;
  const scale = size / Math.min(w, h);
  const { c: tc, ctx } = canvasFrom(null, size, size);
  const dw = w * scale, dh = h * scale;
  ctx.drawImage(c, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return new Promise(r => tc.toBlob(r, "image/jpeg", 0.8));
}

// Thumbnail đóng băng tức thì từ video (áp mirror selfie) → hiện < 50ms
function quickPreviewFromVideo() {
  try {
    const video = store.el.video;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const size = 256;
    const scale = size / Math.min(vw, vh);
    const cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    const { c, ctx } = canvasFrom(null, cw, ch);
    if (store.currentFacing === "user" && store.settings.mirrorSelfie) {
      ctx.translate(cw, 0); ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, cw, ch);
    setThumbProcessing(true);
    c.toBlob(b => { if (b) setGalleryThumb(b, false); }, "image/jpeg", 0.7);
  } catch {}
}

// Segmenter → mask chuyển thành transferable buffer cho worker
async function computeMask(c) {
  const seg = await initSegmenter();
  if (!seg) return null;
  try {
    const res = seg.segment(c);
    // Phase B: confidence mask mềm (0..1) ưu tiên; fallback category mask nhị phân
    let buf, w, h, soft = false;
    if (res.confidenceMasks && res.confidenceMasks[0]) {
      const cm = res.confidenceMasks[0];
      w = cm.width; h = cm.height;
      const f = cm.getAsFloat32Array();
      const u = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i++) u[i] = Math.min(255, Math.max(0, f[i] * 255));
      buf = u.buffer;
      soft = true;
    } else if (res.categoryMask) {
      const cm = res.categoryMask;
      w = cm.width; h = cm.height;
      buf = cm.getAsUint8Array().slice().buffer;
    }
    if (res.close) res.close();
    if (!buf) return null;
    return { buf, w, h, soft };
  } catch (err) {
    console.warn("Segment lỗi:", err);
    return null;
  }
}

// =========================================================
// CHỤP ẢNH — điều phối worker vs fallback
// =========================================================
let latestCaptureId = null;

export async function capturePhoto() {
  if (!store.videoTrack || store.busy) return;
  await pipeline.ready();
  if (!pipeline.isWorkerAvailable()) return capturePhotoSync();

  store.busy = true;
  const mode = getMode(store.mode);
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
  const ts = Date.now();
  const q = store.settings.jpegQuality;
  latestCaptureId = id;

  try {
    // 1) Phản hồi tức thì (trước mọi await)
    shutterSound();
    doFlash();
    if (navigator.vibrate) navigator.vibrate(30);
    quickPreviewFromVideo();

    if (store.flashMode === "on" && mode.pipeline !== "night") flashPulse(280);

    if (mode.pipeline === "night") {
      await capturePhotoNight(id, ts, mode, q);
      return;
    }

    // 2) Grab full frame → hình học cuối (limit → crop → mirror)
    const bitmap = await grabFullFrame();
    let { c } = limitSize(bitmap);
    c = cropAspect(c, store.aspect);
    if (store.currentFacing === "user" && store.settings.mirrorSelfie) c = mirror(c);

    const needsWorker =
      (store.settings.autoEnhance && mode.pipeline !== "pro") ||
      ["portrait", "food", "landscape"].includes(mode.pipeline);

    // 3) Quick-save bản đúng hình học (chưa enhance)
    const quickBlob = await new Promise(r => c.toBlob(r, "image/jpeg", q));
    const quickThumb = await makeQuickThumb(c);
    const savePromise = saveMedia({ id, ts, blob: quickBlob, thumbBlob: quickThumb, type: "photo", mode: mode.id, pending: needsWorker });
    savePromise.then(item => { if (latestCaptureId === id) setGalleryThumb(item.thumbBlob || item.blob, false); });
    store.busy = false; // mở khoá nút chụp NGAY

    if (!needsWorker) {
      await savePromise;
      if (pipeline.pendingJobs() === 0) setThumbProcessing(false);
      maybeAutoDownload(quickBlob, ts);
      return;
    }

    // 4) Portrait: segment trên main thread → mask transferable
    let mask = null;
    if (mode.pipeline === "portrait") mask = await computeMask(c);

    // 5) Dispatch worker
    const workBitmap = await createImageBitmap(c);
    const job = {
      kind: "photo", bitmap: workBitmap, mode: mode.pipeline,
      autoEnhance: store.settings.autoEnhance, jpegQuality: q,
      mask, portraitBlur: store.settings.portraitBlur,
    };
    try {
      const res = await pipeline.enhanceInWorker(job);
      await savePromise;
      const updated = await updateMedia(id, { blob: res.blob, thumbBlob: res.thumbBlob, pending: false });
      if (updated && latestCaptureId === id) setGalleryThumb(updated.thumbBlob || updated.blob, false);
      maybeAutoDownload(res.blob, ts);
    } catch (err) {
      console.warn("Worker xử lý lỗi:", err);
      await savePromise;
      await updateMedia(id, { pending: false });
      store.el.toast && store.el.toast("Không xử lý được ảnh — đã lưu bản gốc");
      maybeAutoDownload(quickBlob, ts);
    } finally {
      if (pipeline.pendingJobs() === 0) setThumbProcessing(false);
    }
  } catch (err) {
    console.error("Chụp lỗi:", err);
    store.busy = false;
    if (pipeline.pendingJobs() === 0) setThumbProcessing(false);
  }
}

// Đường chụp Đêm (burst → worker stacking)
async function capturePhotoNight(id, ts, mode, q) {
  showCenterHint("Giữ chắc tay 📷");
  const canvases = [];
  for (let i = 0; i < 6; i++) {
    canvases.push(frameToFinalCanvas());
    if (i < 5) await new Promise(r => setTimeout(r, 90));
  }
  hideCenterHint();

  // Quick-save frame #0 (đã crop/mirror)
  const quickBlob = await new Promise(r => canvases[0].toBlob(r, "image/jpeg", q));
  const quickThumb = await makeQuickThumb(canvases[0]);
  const savePromise = saveMedia({ id, ts, blob: quickBlob, thumbBlob: quickThumb, type: "photo", mode: mode.id, pending: true });
  savePromise.then(item => { if (latestCaptureId === id) setGalleryThumb(item.thumbBlob || item.blob, false); });
  store.busy = false;

  const bitmaps = await Promise.all(canvases.map(c => createImageBitmap(c)));
  const job = { kind: "night", bitmaps, jpegQuality: q, autoEnhance: store.settings.autoEnhance };
  try {
    const res = await pipeline.enhanceInWorker(job);
    await savePromise;
    const updated = await updateMedia(id, { blob: res.blob, thumbBlob: res.thumbBlob, pending: false });
    if (updated && latestCaptureId === id) setGalleryThumb(updated.thumbBlob || updated.blob, false);
    maybeAutoDownload(res.blob, ts);
  } catch (err) {
    console.warn("Worker đêm lỗi:", err);
    await savePromise;
    await updateMedia(id, { pending: false });
    store.el.toast && store.el.toast("Không xử lý được ảnh — đã lưu bản gốc");
    maybeAutoDownload(quickBlob, ts);
  } finally {
    if (pipeline.pendingJobs() === 0) setThumbProcessing(false);
  }
}

// =========================================================
// FALLBACK ĐỒNG BỘ (không có OffscreenCanvas/module worker)
// Giữ nguyên luồng bản cũ, thêm auto-download.
// =========================================================
async function grabVideoFrames(count = 6, gap = 90) {
  const video = store.el.video;
  const w = video.videoWidth, h = video.videoHeight;
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(canvasFrom(video, w, h).c);
    if (i < count - 1) await new Promise(r => setTimeout(r, gap));
  }
  return frames;
}

async function applyPortraitSync(c) {
  const seg = await initSegmenter();
  if (!seg) return c;
  try {
    const res = seg.segment(c);
    if (res.confidenceMasks && res.confidenceMasks[0]) {
      const cm = res.confidenceMasks[0];
      const f = cm.getAsFloat32Array();
      const u = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i++) u[i] = Math.min(255, Math.max(0, f[i] * 255));
      portraitBokeh(c, u, cm.width, cm.height, store.settings.portraitBlur, true);
    } else if (res.categoryMask) {
      const cm = res.categoryMask;
      portraitBokeh(c, cm.getAsUint8Array(), cm.width, cm.height, store.settings.portraitBlur, false);
    }
    if (res.close) res.close();
  } catch (err) {
    console.warn("Portrait segment lỗi:", err);
  }
  return c;
}

async function capturePhotoSync() {
  if (store.busy) return;
  store.busy = true;
  const mode = getMode(store.mode);
  const ts = Date.now();
  try {
    shutterSound();
    doFlash();
    if (navigator.vibrate) navigator.vibrate(30);
    if (store.flashMode === "on" && mode.pipeline !== "night") flashPulse(280);
    setThumbProcessing(true);

    let canvas;
    if (mode.pipeline === "night") {
      showCenterHint("Giữ chắc tay 📷");
      const frames = await grabVideoFrames(6, 90);
      hideCenterHint();
      const stacked = stackFrames(frames);
      canvas = cropAspect(stacked, store.aspect);
    } else {
      const bitmap = await grabFullFrame();
      let { c } = limitSize(bitmap);
      c = cropAspect(c, store.aspect);
      if (mode.pipeline === "portrait") c = await applyPortraitSync(c);
      else if (mode.pipeline === "food" || mode.pipeline === "landscape") applyModeFilter(c, mode.pipeline);
      canvas = c;
    }

    if (store.settings.autoEnhance && mode.pipeline !== "pro") autoEnhance(canvas);
    if (store.currentFacing === "user" && store.settings.mirrorSelfie) canvas = mirror(canvas);

    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", store.settings.jpegQuality));
    if (blob) {
      const item = await saveMedia({ ts, blob, type: "photo", mode: mode.id });
      setGalleryThumb(item.thumbBlob || item.blob, false);
      maybeAutoDownload(blob, ts);
    }
  } catch (err) {
    console.error("Chụp lỗi (sync):", err);
  } finally {
    setThumbProcessing(false);
    store.busy = false;
  }
}

// =========================================================
// QUAY VIDEO (MediaRecorder)
// =========================================================
export function startRecording() {
  if (!store.stream || store.recording) return;
  const types = [
    "video/mp4;codecs=h264",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  const mime = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(store.stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  } catch {
    rec = new MediaRecorder(store.stream);
  }
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: mime || "video/webm" });
    const item = await saveMedia({ blob, type: "video", mode: "video" });
    setGalleryThumb(item.thumbBlob || item.blob, true);
  };
  rec.start(1000);
  store.recorder = rec;
  store.recording = true;
  if (navigator.vibrate) navigator.vibrate(30);
}

export function stopRecording() {
  if (store.recorder && store.recording) {
    store.recorder.stop();
    store.recording = false;
    store.recorder = null;
    if (navigator.vibrate) navigator.vibrate(30);
  }
}

// -------- Thumbnail helpers (revoke URL cũ chống rò rỉ) --------
let lastThumbUrl = null;
export function setGalleryThumb(blob, isVideo) {
  const g = store.el.galleryThumb;
  if (!g || !blob) return;
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = URL.createObjectURL(blob);
  g.querySelector("img").src = lastThumbUrl;
  g.classList.remove("hidden");
  g.querySelector(".badge-vid").style.display = isVideo ? "block" : "none";
}
function setThumbProcessing(on) {
  const g = store.el.galleryThumb;
  if (g) g.classList.toggle("processing", on);
}
function showCenterHint(text) {
  const h = store.el.centerHint;
  if (h) { h.textContent = text; h.classList.add("show"); }
}
function hideCenterHint() {
  store.el.centerHint && store.el.centerHint.classList.remove("show");
}
