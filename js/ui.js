/* =========================================================
 * ui.js — Wiring DOM: top bar, mode carousel, lens bar,
 * settings sheet, gallery, pro panel, timer, horizon, toast.
 * ========================================================= */
import { store, saveSettings } from "./state.js";
import { MODES, getMode } from "./modes.js";
import { PREVIEW_FILTERS } from "./enhance.js";
import {
  startCamera, enumerateLenses, setTorch, applyEV, tapFocus,
  bindEVDrag, applyAspectMask, bindPinchZoom, setZoomUI, hasRange,
} from "./camera.js";
import { capturePhoto, startRecording, stopRecording, setGalleryThumb } from "./capture.js";
import { initFaceDetector, initObjectDetector, initSegmenter } from "./ai.js";
import * as gallery from "./gallery.js";

// -------- Thu thập DOM refs vào store.el --------
export function collectDom() {
  const ids = [
    "stage","video","overlay","flash","focusRing","evTrack","evSun",
    "maskTop","maskBottom","maskLeft","maskRight","horizon",
    "aiBadge","aiDot","aiText","guide","countdown","centerHint",
    "flashBtn","timerBtn","gridBtn","settingsBtn","aspectSeg",
    "proPanel","histogram","modeBar","lensBar","zoomWrap","zoom","zoomVal",
    "blurWrap","blurSlider","blurVal",
    "galleryThumb","shutter","shutterProg","flip","recTimer","recTime",
    "sheetBackdrop","settingsSheet","closeSheet",
    "setQuality","qualitySub","setSound","setEnhance","setSuggest","setAuto","setMirror","setGrid","setDownload",
    "gallery","galleryBack","galleryGrid","viewer","viewerClose","viewerMedia","viewerInfo",
    "viewerShare","viewerDownload","viewerDelete",
    "sceneToast","sceneToastText","sceneAccept","sceneDismiss",
  ];
  const el = {};
  for (const id of ids) el[id] = document.getElementById(id);
  el.octx = el.overlay.getContext("2d");
  el.toast = toast;
  store.el = el;
}

// -------- Toast đơn giản (tái dụng centerHint) --------
let toastTimer = null;
export function toast(msg, ms = 2200) {
  const h = store.el.centerHint;
  if (!h) return;
  h.textContent = msg; h.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => h.classList.remove("show"), ms);
}

// -------- Badge AI --------
export function setAiStatus(state, text) {
  store.aiState = state;
  if (store.el.aiText) store.el.aiText.textContent = text;
  if (store.el.aiDot) store.el.aiDot.className = "dot " + state;
}

// =========================================================
// MODE CAROUSEL
// =========================================================
export function buildModeBar(onChange) {
  const bar = store.el.modeBar;
  bar.innerHTML = "";
  for (const m of MODES) {
    const b = document.createElement("button");
    b.className = "mode-item" + (m.id === store.mode ? " active" : "");
    b.textContent = m.label;
    b.dataset.mode = m.id;
    b.addEventListener("click", () => setMode(m.id, onChange));
    bar.appendChild(b);
  }
  // swipe trái/phải trên preview đổi mode
  bindModeSwipe(onChange);
  centerActiveMode();
}

export function setMode(id, onChange) {
  const m = getMode(id);
  store.mode = m.id;
  // Cập nhật highlight
  store.el.modeBar.querySelectorAll(".mode-item").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === m.id));
  centerActiveMode();

  // Preview CSS filter
  applyPreviewFilter();

  // Panel UI theo mode
  toggleModeUI(m);

  // Nút chụp: video → đỏ
  const shutter = store.el.shutter;
  shutter.classList.toggle("video", m.id === "video");
  if (store.recording) stopRecording(), stopRecUI();

  // Lazy-init AI theo mode
  if (m.ai === "object") initObjectDetector(setAiStatus);
  else if (m.ai === "face") initFaceDetector();

  onChange && onChange(m);
}

function applyPreviewFilter() {
  const video = store.el.video;
  video.style.filter = PREVIEW_FILTERS[store.mode] || "none";
}

function toggleModeUI(m) {
  const ui = m.ui || [];
  store.el.blurWrap.classList.toggle("hidden", !ui.includes("blurSlider"));
  store.el.proPanel.classList.toggle("show", ui.includes("proPanel"));
  store.el.histogram.classList.toggle("show", ui.includes("histogram"));
  store.el.horizon.classList.toggle("show", ui.includes("horizon"));
  if (ui.includes("proPanel")) buildProPanel();
}

function centerActiveMode() {
  const active = store.el.modeBar.querySelector(".mode-item.active");
  if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

function bindModeSwipe(onChange) {
  const stage = store.el.stage;
  let x0 = null, y0 = null;
  stage.addEventListener("touchstart", e => {
    if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }
  }, { passive: true });
  stage.addEventListener("touchend", e => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const idx = MODES.findIndex(m => m.id === store.mode);
      const next = dx < 0 ? Math.min(MODES.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (next !== idx) setMode(MODES[next].id, onChange);
    }
    x0 = y0 = null;
  }, { passive: true });
}

// =========================================================
// LENS BAR (đa ống kính)
// =========================================================
export async function buildLensBar() {
  const bar = store.el.lensBar;
  bar.innerHTML = "";
  const lenses = await enumerateLenses();
  // Chỉ hiện nếu có >1 ống kính sau thật
  if (store.currentFacing === "user" || lenses.length < 2) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  for (const lens of lenses) {
    const b = document.createElement("button");
    b.className = "lens-btn";
    b.textContent = (lens.zoomFactor % 1 === 0 ? lens.zoomFactor : lens.zoomFactor.toFixed(1)) + "x";
    b.dataset.deviceId = lens.deviceId;
    if (lens.deviceId === store.currentDeviceId) b.classList.add("active");
    b.addEventListener("click", async () => {
      await startCamera({ deviceId: lens.deviceId });
      bar.querySelectorAll(".lens-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      refreshZoom();
      applyAspectMask();
    });
    bar.appendChild(b);
  }
}

// =========================================================
// ZOOM
// =========================================================
export function refreshZoom() {
  const caps = store.caps, wrap = store.el.zoomWrap, input = store.el.zoom, val = store.el.zoomVal;
  if (hasRange(caps.zoom)) {
    const s = store.trackSettings || {};
    input.min = caps.zoom.min; input.max = caps.zoom.max; input.step = caps.zoom.step || 0.1;
    input.value = s.zoom || caps.zoom.min;
    val.textContent = Number(input.value).toFixed(1) + "x";
    wrap.classList.add("show");
  } else {
    // zoom số
    input.min = 1; input.max = 6; input.step = 0.1; input.value = store.digitalZoom || 1;
    val.textContent = Number(input.value).toFixed(1) + "x";
    wrap.classList.add("show");
  }
  input.oninput = () => setZoomUI(Number(input.value));
}

// =========================================================
// PRO PANEL (dựng động theo caps)
// =========================================================
export function buildProPanel() {
  const panel = store.el.proPanel;
  panel.innerHTML = "";
  const caps = store.caps, track = store.videoTrack;
  const controls = [
    { key: "iso", label: "ISO", constraint: "iso" },
    { key: "exposureTime", label: "SHUT", constraint: "exposureTime" },
    { key: "colorTemperature", label: "WB", constraint: "colorTemperature" },
    { key: "focusDistance", label: "FOC", constraint: "focusDistance" },
    { key: "exposureCompensation", label: "EV", constraint: "exposureCompensation" },
  ];
  let any = false;
  for (const c of controls) {
    const cap = caps[c.key];
    if (!hasRange(cap)) continue;
    any = true;
    const wrap = document.createElement("div");
    wrap.className = "pro-ctrl";
    const s = store.trackSettings || {};
    const cur = (s[c.key] != null) ? s[c.key] : (cap.min + cap.max) / 2;
    wrap.innerHTML = `<label>${c.label}</label>
      <input type="range" min="${cap.min}" max="${cap.max}" step="${cap.step || (cap.max-cap.min)/100}" value="${cur}">
      <span class="val">${fmt(cur)}</span>`;
    const input = wrap.querySelector("input");
    const valEl = wrap.querySelector(".val");
    input.addEventListener("input", async () => {
      const v = Number(input.value);
      valEl.textContent = fmt(v);
      const adv = {};
      if (c.key === "iso" || c.key === "exposureTime") adv.exposureMode = "manual";
      if (c.key === "colorTemperature") adv.whiteBalanceMode = "manual";
      if (c.key === "focusDistance") adv.focusMode = "manual";
      adv[c.key] = v;
      try { await track.applyConstraints({ advanced: [adv] }); } catch {}
    });
    panel.appendChild(wrap);
  }
  if (!any) {
    panel.innerHTML = `<div style="font-size:10px; color:#888; text-align:center; padding:8px;">Máy không hỗ trợ<br>chỉnh tay qua web</div>`;
  }
}
function fmt(v) { return Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1); }

// =========================================================
// TOP BAR (flash, timer, grid, settings, aspect) + tap focus
// =========================================================
export function bindTopBar() {
  const el = store.el;

  // Flash: off → auto → on
  const flashIcons = { off: "off", auto: "A", on: "on" };
  el.flashBtn.addEventListener("click", () => {
    const order = ["off", "auto", "on"];
    store.flashMode = order[(order.indexOf(store.flashMode) + 1) % 3];
    el.flashBtn.classList.toggle("on", store.flashMode !== "off");
    // torch on ngay nếu 'on' và mode xem trước tối? Chỉ hiện trạng thái.
    if (store.flashMode === "on" && store.caps.torch && store.mode !== "photo") {
      // giữ để chớp lúc chụp
    }
    toast("Flash: " + ({ off: "Tắt", auto: "Tự động", on: "Bật" }[store.flashMode]), 1000);
    if (store.flashMode !== "on") setTorch(false);
  });

  // Timer 0 → 3 → 10
  el.timerBtn.addEventListener("click", () => {
    const order = [0, 3, 10];
    store.timer = order[(order.indexOf(store.timer) + 1) % 3];
    el.timerBtn.classList.toggle("on", store.timer !== 0);
    toast(store.timer === 0 ? "Hẹn giờ: Tắt" : `Hẹn giờ: ${store.timer}s`, 1000);
  });

  // Grid
  el.gridBtn.addEventListener("click", () => {
    store.gridOn = !store.gridOn;
    store.settings.grid = store.gridOn;
    saveSettings();
    el.gridBtn.classList.toggle("on", store.gridOn);
  });

  // Aspect
  el.aspectSeg.querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      store.aspect = b.dataset.aspect;
      el.aspectSeg.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      applyAspectMask();
    });
  });

  // Settings sheet
  el.settingsBtn.addEventListener("click", () => openSheet(true));
  el.closeSheet.addEventListener("click", () => openSheet(false));
  el.sheetBackdrop.addEventListener("click", () => openSheet(false));

  // Badge AI: chạm để mở rộng
  el.aiBadge.addEventListener("click", () => el.aiBadge.classList.toggle("expanded"));

  // Tap-to-focus (single tap trên stage, phân biệt với swipe)
  bindTapFocus();
  bindEVDrag();
  bindPinchZoom();

  // Blur slider (chân dung)
  el.blurSlider.addEventListener("input", () => {
    store.settings.portraitBlur = Number(el.blurSlider.value);
    el.blurVal.textContent = el.blurSlider.value;
    saveSettings();
  });
}

function bindTapFocus() {
  const stage = store.el.stage;
  let downX, downY, downT;
  stage.addEventListener("pointerdown", e => {
    downX = e.clientX; downY = e.clientY; downT = Date.now();
  });
  stage.addEventListener("pointerup", e => {
    const dx = Math.abs(e.clientX - downX), dy = Math.abs(e.clientY - downY);
    if (dx < 12 && dy < 12 && Date.now() - downT < 350) {
      tapFocus(e.clientX, e.clientY);
    }
  });
}

function openSheet(show) {
  store.el.settingsSheet.classList.toggle("show", show);
  store.el.sheetBackdrop.classList.toggle("show", show);
}

// =========================================================
// SETTINGS BINDINGS
// =========================================================
export function bindSettings() {
  const el = store.el, s = store.settings;
  // init từ store
  el.setQuality.value = s.jpegQuality; el.qualitySub.textContent = Math.round(s.jpegQuality * 100) + "%";
  el.setSound.checked = s.shutterSound;
  el.setEnhance.checked = s.autoEnhance;
  el.setSuggest.checked = s.sceneSuggest;
  el.setAuto.checked = s.autoShoot;
  el.setMirror.checked = s.mirrorSelfie;
  el.setGrid.checked = s.grid;
  if (el.setDownload) el.setDownload.checked = s.autoDownload;
  el.blurSlider.value = s.portraitBlur; el.blurVal.textContent = s.portraitBlur;
  store.gridOn = s.grid;
  store.el.gridBtn.classList.toggle("on", s.grid);

  const bind = (input, key, after) => input.addEventListener("input", () => {
    s[key] = input.type === "checkbox" ? input.checked : Number(input.value);
    saveSettings(); after && after();
  });
  bind(el.setQuality, "jpegQuality", () => el.qualitySub.textContent = Math.round(s.jpegQuality * 100) + "%");
  bind(el.setSound, "shutterSound");
  bind(el.setEnhance, "autoEnhance");
  bind(el.setSuggest, "sceneSuggest");
  bind(el.setAuto, "autoShoot");
  bind(el.setMirror, "mirrorSelfie", () => {
    const v = store.el.video;
    v.classList.toggle("mirror", store.currentFacing === "user" && s.mirrorSelfie);
  });
  bind(el.setGrid, "grid", () => { store.gridOn = s.grid; store.el.gridBtn.classList.toggle("on", s.grid); });
  if (el.setDownload) bind(el.setDownload, "autoDownload");
}

// =========================================================
// SHUTTER + FLIP
// =========================================================
export function bindShutter() {
  const el = store.el;
  el.shutter.addEventListener("click", onShutter);
  el.flip.addEventListener("click", async () => {
    const next = store.currentFacing === "environment" ? "user" : "environment";
    await startCamera({ facing: next });
    refreshZoom();
    buildLensBar();
    applyAspectMask();
    const v = store.el.video;
    v.classList.toggle("mirror", store.currentFacing === "user" && store.settings.mirrorSelfie);
  });
}

async function onShutter() {
  if (store.mode === "video") {
    if (!store.recording) { startRecording(); startRecUI(); }
    else { stopRecording(); stopRecUI(); }
    return;
  }
  // Ảnh: nếu có timer → đếm ngược
  if (store.timer > 0) {
    await runCountdown(store.timer);
  }
  await capturePhoto();
}

// -------- Countdown --------
export function runCountdown(sec) {
  return new Promise(resolve => {
    const cd = store.el.countdown;
    let n = sec;
    cd.classList.add("show");
    const tick = () => {
      cd.querySelector("span").textContent = n;
      beep();
      n--;
      if (n < 0) { cd.classList.remove("show"); resolve(); }
      else setTimeout(tick, 1000);
    };
    tick();
  });
}
let beepCtx = null;
function beep() {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = beepCtx.createOscillator(), g = beepCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.12;
    o.connect(g); g.connect(beepCtx.destination);
    o.start(); o.stop(beepCtx.currentTime + 0.08);
  } catch {}
}

// -------- Record UI --------
let recInterval = null, recStart = 0;
function startRecUI() {
  store.el.shutter.classList.add("recording");
  store.el.recTimer.classList.add("show");
  recStart = Date.now();
  recInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    store.el.recTime.textContent = String((s / 60 | 0)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 500);
}
function stopRecUI() {
  store.el.shutter.classList.remove("recording");
  store.el.recTimer.classList.remove("show");
  clearInterval(recInterval);
}

// =========================================================
// GALLERY UI
// =========================================================
export function bindGallery() {
  const el = store.el;
  el.galleryThumb.addEventListener("click", openGallery);
  el.galleryBack.addEventListener("click", () => el.gallery.classList.remove("show"));
  el.viewerClose.addEventListener("click", () => el.viewer.classList.remove("show"));

  // refresh thumbnail gần nhất khi mở app
  gallery.latest().then(item => { if (item) updateThumbFromItem(item); });
}

function updateThumbFromItem(item) {
  setGalleryThumb(item.thumbBlob || item.blob, item.type === "video");
}

async function openGallery() {
  const el = store.el;
  const items = await gallery.getAll();
  const grid = el.galleryGrid;
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = `<div class="g-empty">Chưa có ảnh nào.<br>Hãy chụp tấm đầu tiên 📷</div>`;
  } else {
    for (const item of items) {
      const cell = document.createElement("div");
      cell.className = "g-cell";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(item.thumbBlob || item.blob);
      cell.appendChild(img);
      if (item.type === "video") {
        const t = document.createElement("span"); t.className = "vtag"; t.textContent = "🎬"; cell.appendChild(t);
      }
      cell.addEventListener("click", () => openViewer(item));
      grid.appendChild(cell);
    }
  }
  el.gallery.classList.add("show");
}

async function openViewer(item) {
  const el = store.el;
  const full = await gallery.getOne(item.id);
  const media = el.viewerMedia;
  media.innerHTML = "";
  const url = URL.createObjectURL(full.blob);
  if (full.type === "video") {
    const v = document.createElement("video");
    v.src = url; v.controls = true; v.playsInline = true; v.autoplay = true;
    media.appendChild(v);
  } else {
    const img = document.createElement("img"); img.src = url; media.appendChild(img);
  }
  el.viewerInfo.textContent = new Date(full.ts).toLocaleString("vi") + " · " + full.mode;
  el.viewer.classList.add("show");

  const ext = full.type === "video" ? (full.blob.type.includes("mp4") ? "mp4" : "webm") : "jpg";
  const fname = `camera-${full.ts}.${ext}`;

  el.viewerDownload.onclick = () => {
    const a = document.createElement("a"); a.href = url; a.download = fname; a.click();
  };
  el.viewerShare.onclick = async () => {
    if (navigator.share && navigator.canShare) {
      const file = new File([full.blob], fname, { type: full.blob.type });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); } catch {}
        return;
      }
    }
    toast("Trình duyệt không hỗ trợ chia sẻ — hãy tải về.");
  };
  el.viewerDelete.onclick = async () => {
    if (confirm("Xoá ảnh/video này?")) {
      await gallery.remove(full.id);
      el.viewer.classList.remove("show");
      openGallery();
      const last = await gallery.latest();
      if (last) updateThumbFromItem(last);
      else { store.el.galleryThumb.classList.add("hidden"); }
    }
  };
}

// =========================================================
// SCENE TOAST (gợi ý chuyển mode)
// =========================================================
let sceneToastActive = false;
export function showSceneToast(text, targetMode, onChange) {
  if (sceneToastActive || !store.settings.sceneSuggest) return;
  sceneToastActive = true;
  const el = store.el;
  el.sceneToastText.textContent = text;
  el.sceneToast.classList.add("show");
  const close = () => { el.sceneToast.classList.remove("show"); sceneToastActive = false; };
  el.sceneAccept.onclick = () => { setMode(targetMode, onChange); close(); };
  el.sceneDismiss.onclick = close;
  setTimeout(close, 5000);
}

// =========================================================
// HORIZON (Phong cảnh) — DeviceOrientation
// =========================================================
export function bindHorizon() {
  window.addEventListener("deviceorientation", e => {
    if (!store.el.horizon.classList.contains("show")) return;
    const roll = e.gamma || 0; // nghiêng trái/phải
    const h = store.el.horizon;
    h.style.transform = `rotate(${-roll}deg)`;
    h.classList.toggle("level", Math.abs(roll) < 2.5);
  });
}
