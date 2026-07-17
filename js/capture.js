/* =========================================================
 * capture.js — Pipeline chụp ảnh
 * takePhoto/canvas → bitmap → crop tỉ lệ → pipeline mode →
 * auto-enhance → mirror selfie → JPEG → lưu gallery.
 * ========================================================= */
import { store } from "./state.js";
import { getMode } from "./modes.js";
import { flashPulse } from "./camera.js";
import { initSegmenter } from "./ai.js";
import { saveMedia } from "./gallery.js";
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

// Lấy nhanh nhiều frame từ video (mode Đêm stacking)
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

// =========================================================
// CHỤP ẢNH (mọi mode trừ video)
// =========================================================
export async function capturePhoto() {
  if (!store.videoTrack || store.busy) return;
  store.busy = true;
  const mode = getMode(store.mode);

  try {
    shutterSound();
    doFlash();
    if (navigator.vibrate) navigator.vibrate(30);

    // Flash phần cứng (torch) nếu flashMode=on và không phải mode Đêm
    if (store.flashMode === "on" && mode.pipeline !== "night") {
      flashPulse(280); // không await để không trễ chụp quá nhiều
    }

    // Hiện spinner tạm trên thumbnail
    setThumbProcessing(true);

    let canvas;

    if (mode.pipeline === "night") {
      store.el.centerHint && showCenterHint("Giữ chắc tay 📷");
      const frames = await grabVideoFrames(6, 90);
      hideCenterHint();
      const stacked = stackFrames(frames);
      canvas = cropAspect(stacked, store.aspect);
    } else {
      const bitmap = await grabFullFrame();
      let { c } = limitSize(bitmap);
      c = cropAspect(c, store.aspect);

      if (mode.pipeline === "portrait") {
        c = await applyPortrait(c);
      } else if (mode.pipeline === "food" || mode.pipeline === "landscape") {
        applyModeFilter(c, mode.pipeline);
      }
      canvas = c;
    }

    // Auto-enhance (trừ Pro; portrait/filter đã xử lý riêng nhưng vẫn enhance nhẹ trừ pro)
    if (store.settings.autoEnhance && mode.pipeline !== "pro") {
      autoEnhance(canvas);
    }

    // Mirror selfie
    if (store.currentFacing === "user" && store.settings.mirrorSelfie) {
      canvas = mirror(canvas);
    }

    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", store.settings.jpegQuality));
    if (blob) {
      const item = await saveMedia({ blob, type: "photo", mode: mode.id });
      updateThumb(item);
    }
  } catch (err) {
    console.error("Chụp lỗi:", err);
  } finally {
    setThumbProcessing(false);
    store.busy = false;
  }
}

// Xoá phông: segmenter → category mask → bokeh
async function applyPortrait(c) {
  const seg = await initSegmenter();
  if (!seg) return c;
  try {
    const res = seg.segment(c);
    const cm = res.categoryMask;
    if (!cm) return c;
    const maskW = cm.width, maskH = cm.height;
    const maskArr = cm.getAsUint8Array();
    // SelfieSegmenter: người thường là category != 0
    portraitBokeh(c, maskArr, maskW, maskH, store.settings.portraitBlur);
    if (res.close) res.close();
  } catch (err) {
    console.warn("Portrait segment lỗi:", err);
  }
  return c;
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
    updateThumb(item);
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

// -------- Thumbnail helpers --------
function updateThumb(item) {
  const g = store.el.galleryThumb;
  if (!g || !item) return;
  const url = URL.createObjectURL(item.thumbBlob || item.blob);
  g.querySelector("img").src = url;
  g.classList.remove("hidden");
  g.querySelector(".badge-vid").style.display = item.type === "video" ? "block" : "none";
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
