/* =========================================================
 * ai.js — MediaPipe: ObjectDetector, FaceDetector, ImageSegmenter
 * Lazy-init theo mode để mở app nhanh. Pattern GPU→CPU fallback.
 * ========================================================= */
import { store, MP_BASE, MODELS } from "./state.js";

let visionFileset = null;

async function getFileset() {
  if (visionFileset) return visionFileset;
  const mod = await import(`${MP_BASE}`);
  store._mp = mod; // giữ lại FilesetResolver + các class
  visionFileset = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  return visionFileset;
}

// Tạo task với GPU→CPU fallback (dùng chung cho mọi loại)
async function createWithFallback(createFn, options) {
  try {
    return await createFn({ ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } });
  } catch (gpuErr) {
    console.warn("GPU delegate lỗi, thử CPU:", gpuErr);
    return await createFn({ ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } });
  }
}

// -------- Object Detector (bố cục 1/3) --------
export async function initObjectDetector(setAiStatus) {
  if (store.objectDetector) return store.objectDetector;
  setAiStatus && setAiStatus("loading", "Đang tải AI…");
  try {
    const fileset = await getFileset();
    const { ObjectDetector } = store._mp;
    store.objectDetector = await createWithFallback(
      (o) => ObjectDetector.createFromOptions(fileset, o),
      { baseOptions: { modelAssetPath: MODELS.object }, runningMode: "VIDEO", scoreThreshold: 0.5, maxResults: 5 }
    );
    setAiStatus && setAiStatus("ready", "AI sẵn sàng");
    return store.objectDetector;
  } catch (err) {
    console.error("ObjectDetector lỗi:", err);
    setAiStatus && setAiStatus("error", "AI lỗi — vẫn chụp được");
    store.objectDetector = null;
    return null;
  }
}

// -------- Face Detector (mode Chân dung) --------
export async function initFaceDetector() {
  if (store.faceDetector) return store.faceDetector;
  try {
    const fileset = await getFileset();
    const { FaceDetector } = store._mp;
    store.faceDetector = await createWithFallback(
      (o) => FaceDetector.createFromOptions(fileset, o),
      { baseOptions: { modelAssetPath: MODELS.face }, runningMode: "VIDEO", minDetectionConfidence: 0.5 }
    );
    return store.faceDetector;
  } catch (err) {
    console.warn("FaceDetector lỗi:", err);
    store.faceDetector = null;
    return null;
  }
}

// -------- Image Segmenter (xoá phông chân dung) — chỉ khi chụp --------
export async function initSegmenter() {
  if (store.segmenter) return store.segmenter;
  try {
    const fileset = await getFileset();
    const { ImageSegmenter } = store._mp;
    store.segmenter = await createWithFallback(
      (o) => ImageSegmenter.createFromOptions(fileset, o),
      {
        baseOptions: { modelAssetPath: MODELS.segmenter },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }
    );
    return store.segmenter;
  } catch (err) {
    console.warn("Segmenter lỗi:", err);
    store.segmenter = null;
    return null;
  }
}

// -------- Detect helpers (an toàn với lỗi lẻ frame) --------
export function detectObjects(video, ts) {
  if (!store.objectDetector) return null;
  try { return store.objectDetector.detectForVideo(video, ts); } catch { return null; }
}
export function detectFaces(video, ts) {
  if (!store.faceDetector) return null;
  try { return store.faceDetector.detectForVideo(video, ts); } catch { return null; }
}

// =========================================================
// GỢI Ý CẢNH — sample 64×64, đo độ sáng trung bình
// =========================================================
const sampleCanvas = document.createElement("canvas");
sampleCanvas.width = 64; sampleCanvas.height = 64;
const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });

export function sampleBrightness(video) {
  if (!video.videoWidth) return null;
  try {
    sctx.drawImage(video, 0, 0, 64, 64);
    const data = sctx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (data.length / 4); // 0..255
  } catch { return null; }
}

// Histogram luma cho Pro mode (trả mảng 64 bins)
export function sampleHistogram(video) {
  if (!video.videoWidth) return null;
  try {
    sctx.drawImage(video, 0, 0, 64, 64);
    const data = sctx.getImageData(0, 0, 64, 64).data;
    const bins = new Array(64).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      bins[Math.min(63, l / 4 | 0)]++;
    }
    return bins;
  } catch { return null; }
}
