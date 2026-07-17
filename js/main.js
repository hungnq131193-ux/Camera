/* =========================================================
 * main.js — Điểm vào: wiring toàn bộ + vòng lặp render.
 * ========================================================= */
import { store } from "./state.js";
import { getMode } from "./modes.js";
import { startCamera, applyAspectMask } from "./camera.js";
import { drawRuleOfThirds, handleComposition, drawFaces } from "./composition.js";
import { detectObjects, detectFaces, sampleBrightness, sampleHistogram } from "./ai.js";
import {
  collectDom, setAiStatus, buildModeBar, setMode, buildLensBar,
  refreshZoom, bindTopBar, bindSettings, bindShutter, bindGallery,
  bindHorizon, showSceneToast, toast,
} from "./ui.js";
import { capturePhoto } from "./capture.js";
import * as pipeline from "./pipeline.js";

// -------- Overlay resize --------
function resizeOverlay() {
  const overlay = store.el.overlay;
  const rect = overlay.getBoundingClientRect();
  overlay.width = Math.round(rect.width);
  overlay.height = Math.round(rect.height);
}

// -------- Guide update (debounce) --------
function updateGuide(msg, tone) {
  if (msg === store.lastGuideMsg) return;
  store.lastGuideMsg = msg;
  const guide = store.el.guide;
  guide.textContent = msg;
  guide.className = "";
  if (tone === "good") guide.classList.add("good");
  else if (tone === "adjust") guide.classList.add("adjust");
}

// -------- Vòng lặp render --------
let histTimer = 0, sceneTimer = 0;
function renderLoop() {
  requestAnimationFrame(renderLoop);
  const video = store.el.video, octx = store.el.octx, overlay = store.el.overlay;
  if (!video.videoWidth) return;

  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (store.gridOn && store.mode !== "video") drawRuleOfThirds(octx, overlay);

  const mode = getMode(store.mode);
  const ctx = { octx, overlay, video, updateGuide };

  // Chỉ detect khi có frame mới
  if (video.currentTime !== store.lastVideoTime) {
    store.lastVideoTime = video.currentTime;
    const ts = performance.now();

    if (mode.ai === "object" && store.objectDetector) {
      const res = detectObjects(video, ts);
      if (res && res.detections && res.detections.length) {
        const good = handleComposition(res.detections, ctx);
        handleAutoShoot(good);
      } else {
        updateGuide("Hướng máy vào chủ thể…", "neutral");
        store.goodStreak = 0;
      }
    } else if (mode.ai === "face" && store.faceDetector) {
      const res = detectFaces(video, ts);
      if (res && res.detections && res.detections.length) {
        drawFaces(octx, res.detections, video, overlay);
        updateGuide("Đã nhận diện khuôn mặt 😊", "good");
      } else {
        updateGuide("Hướng vào khuôn mặt…", "neutral");
      }
    } else if (mode.id === "food" || mode.id === "pro" || mode.id === "video") {
      updateGuide(modeHint(mode.id), "neutral");
    }
  }

  // Histogram realtime (Pro) mỗi ~200ms
  if (store.mode === "pro" && performance.now() - histTimer > 200) {
    histTimer = performance.now();
    drawHistogram();
  }

  // Gợi ý cảnh mỗi ~1s
  if (store.settings.sceneSuggest && performance.now() - sceneTimer > 1500) {
    sceneTimer = performance.now();
    sceneSuggest();
  }
}

function modeHint(id) {
  return {
    food: "Chế độ Món ăn — tone ấm, sống động 🍜",
    pro: "Chế độ Pro — chỉnh tay thông số",
    video: "Chạm nút đỏ để quay 🎬",
  }[id] || "";
}

// -------- Auto shoot --------
function handleAutoShoot(good) {
  if (!store.settings.autoShoot || store.mode === "video") { store.goodStreak = 0; return; }
  if (good) {
    store.goodStreak++;
    // ~1.5s ổn định (giả sử ~30fps detect → nhưng detect theo frame video)
    if (store.goodStreak === 1) store._goodSince = performance.now();
    if (performance.now() - (store._goodSince || 0) > 1500 && !store.busy) {
      store.goodStreak = 0;
      capturePhoto();
    }
  } else {
    store.goodStreak = 0;
  }
}

// -------- Histogram (Pro) --------
function drawHistogram() {
  const bins = sampleHistogram(store.el.video);
  const cvs = store.el.histogram;
  if (!bins || !cvs) return;
  const ctx = cvs.getContext("2d");
  const W = cvs.width, H = cvs.height;
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(...bins) || 1;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  const bw = W / bins.length;
  for (let i = 0; i < bins.length; i++) {
    const bh = (bins[i] / max) * H;
    ctx.fillRect(i * bw, H - bh, bw + 0.5, bh);
  }
}

// -------- Scene suggest --------
let lastSuggest = 0;
function sceneSuggest() {
  const b = sampleBrightness(store.el.video);
  if (b == null) return;
  const now = performance.now();
  if (now - lastSuggest < 12000) return; // không spam
  if (b < 50 && store.mode !== "night") {
    lastSuggest = now;
    showSceneToast("Ánh sáng yếu — chuyển chế độ Đêm?", "night", onModeChange);
  } else if (store.faceDetector && store.mode !== "portrait") {
    const res = detectFaces(store.el.video, now);
    if (res && res.detections && res.detections.length) {
      const f = res.detections[0].boundingBox;
      if (f && (f.width * f.height) / (store.el.video.videoWidth * store.el.video.videoHeight) > 0.08) {
        lastSuggest = now;
        showSceneToast("Có khuôn mặt gần — chuyển Chân dung?", "portrait", onModeChange);
      }
    }
  }
}

function onModeChange(mode) {
  applyAspectMask();
}

// -------- Network badge --------
function updateNet() {
  // gộp vào badge AI? giữ đơn giản: chỉ log
}
window.addEventListener("resize", () => { resizeOverlay(); applyAspectMask(); });
window.addEventListener("orientationchange", () => setTimeout(() => { resizeOverlay(); applyAspectMask(); }, 300));

// =========================================================
// KHỞI ĐỘNG
// =========================================================
async function main() {
  collectDom();
  store.aspect = "4:3";
  store.gridOn = store.settings.grid;

  bindTopBar();
  bindSettings();
  bindShutter();
  bindGallery();
  bindHorizon();
  buildModeBar(onModeChange);

  resizeOverlay();
  renderLoop();

  // Khởi tạo worker xử lý ảnh (handshake) song song để lần chụp đầu tức thì
  pipeline.ready();

  const ok = await startCamera({ facing: "environment" });
  resizeOverlay();
  applyAspectMask();

  if (ok) {
    refreshZoom();
    buildLensBar();
    // set mode mặc định (khởi tạo object detector)
    setMode(store.mode, onModeChange);
  }

  // Deep link ?open=gallery
  if (new URLSearchParams(location.search).get("open") === "gallery") {
    store.el.galleryThumb.click();
  }

  // Xin lưu bền
  import("./gallery.js").then(g => g.requestPersist());
}

// -------- Service Worker --------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then(reg => console.log("SW OK:", reg.scope))
      .catch(err => console.warn("SW lỗi:", err));
  });
}

main();
