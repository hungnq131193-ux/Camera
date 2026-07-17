/* =========================================================
 * state.js — Trạng thái dùng chung + settings + DOM refs
 * Một object `store` duy nhất được các module import & chia sẻ,
 * tránh circular import (main.js là nơi wiring cuối).
 * ========================================================= */

// ------- Cài đặt người dùng (lưu localStorage) -------
const DEFAULT_SETTINGS = {
  jpegQuality: 0.92,
  shutterSound: true,
  autoEnhance: true,
  sceneSuggest: true,
  autoShoot: false,
  mirrorSelfie: true,
  grid: true,
  portraitBlur: 14,   // mức xoá phông (0–25)
  autoDownload: true, // tự tải JPEG về thư mục Tải xuống
  hdrMode: false,     // HDR bracketing (mode Ảnh, cần EV)
};

function loadSettings() {
  try {
    const raw = localStorage.getItem("cameraai.settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings() {
  try { localStorage.setItem("cameraai.settings", JSON.stringify(store.settings)); } catch {}
}

// ------- Store toàn cục -------
export const store = {
  el: {},                     // DOM refs, ui.js điền

  // Camera hardware
  stream: null,
  videoTrack: null,
  imageCapture: null,
  currentFacing: "environment",
  currentDeviceId: null,
  caps: {},                   // getCapabilities() snapshot
  trackSettings: {},          // getSettings() snapshot
  lenses: [],                 // [{deviceId, label, kind:'ultra'|'wide'|'tele', zoomFactor}]
  digitalZoom: 1,             // zoom số hiện tại (nếu không có lens thật)

  // Aspect + grid
  aspect: "4:3",              // "4:3" | "16:9" | "1:1"
  gridOn: true,

  // Flash / torch / timer
  flashMode: "off",           // "off" | "on" | "auto"
  torchOn: false,
  timer: 0,                   // 0 | 3 | 10 (giây)
  ev: 0,                      // exposure compensation hiện tại

  // AI detectors (lazy)
  objectDetector: null,
  faceDetector: null,
  segmenter: null,
  aiState: "idle",

  // Mode
  mode: "photo",

  // Render loop
  lastVideoTime: -1,
  lastDetectMs: 0,           // throttle detect ~12Hz
  lastGuideMsg: "",
  goodStreak: 0,             // cho auto-shoot
  darkStreak: 0,             // gợi ý Đêm cần vài mẫu tối liên tiếp
  busy: false,               // đang chụp/xử lý

  // Recording
  recorder: null,
  recording: false,

  settings: loadSettings(),
};

// ------- Constant model URLs (phải KHỚP với sw.js) -------
export const MP_VER = "0.10.22";
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
export const MODELS = {
  object: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite",
  face:   "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  segmenter: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
};
