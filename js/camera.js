/* =========================================================
 * camera.js — Khai thác tối đa phần cứng camera
 * startCamera (fallback chain), đa ống kính, getCapabilities đầy đủ,
 * zoom, tap-to-focus + EV, torch, tỉ lệ khung.
 * ========================================================= */
import { store } from "./state.js";
import { canvasPointToVideoNorm } from "./composition.js";

// -------- Mở camera (giữ fallback chain gốc, thêm deviceId) --------
export async function startCamera({ facing = store.currentFacing, deviceId = null } = {}) {
  stopStream();

  const base = {
    width:  { ideal: 4096 },
    height: { ideal: 2160 },
    advanced: [{ focusMode: "continuous" }],
  };

  let attempts;
  if (deviceId) {
    attempts = [{ ...base, deviceId: { exact: deviceId } }];
  } else {
    const facingAttempts = facing === "environment"
      ? [{ exact: "environment" }, "environment", "user"]
      : [{ exact: "user" }, "user", "environment"];
    attempts = facingAttempts.map(f => ({ ...base, facingMode: f }));
  }

  let stream = null, lastErr = null, usedFacing = facing;
  for (const v of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: v });
      if (v.facingMode) usedFacing = (typeof v.facingMode === "string") ? v.facingMode : v.facingMode.exact;
      break;
    } catch (err) { lastErr = err; }
  }

  if (!stream) {
    console.error("Không mở được camera:", lastErr);
    if (store.el.guide) {
      store.el.guide.textContent = "⚠️ Không truy cập được camera. Kiểm tra quyền & HTTPS.";
    }
    return false;
  }

  store.stream = stream;
  store.videoTrack = stream.getVideoTracks()[0];
  store.currentFacing = usedFacing;
  store.currentDeviceId = deviceId || (store.videoTrack.getSettings && store.videoTrack.getSettings().deviceId) || null;

  const video = store.el.video;
  video.srcObject = stream;
  applyMirror();
  await video.play().catch(() => {});
  await waitForVideoReady(video);

  setupCapabilities();

  try {
    store.imageCapture = ("ImageCapture" in window) ? new ImageCapture(store.videoTrack) : null;
  } catch { store.imageCapture = null; }

  return true;
}

function waitForVideoReady(video) {
  return new Promise((resolve) => {
    if (video.videoWidth > 0) return resolve();
    video.onloadedmetadata = () => resolve();
  });
}

export function stopStream() {
  if (store.stream) {
    store.stream.getTracks().forEach(t => t.stop());
    store.stream = null;
  }
  store.videoTrack = null;
  store.imageCapture = null;
  store.torchOn = false;
}

// Camera trước bị lật gương → thêm class mirror nếu bật setting
export function applyMirror() {
  const video = store.el.video;
  const shouldMirror = store.currentFacing === "user" && store.settings.mirrorSelfie;
  video.classList.toggle("mirror", shouldMirror);
}

// -------- Liệt kê ống kính (đa camera sau) --------
export async function enumerateLenses() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");
    // Chỉ lấy ống kính sau (loại bỏ front nếu nhận diện được)
    const back = cams.filter(d => {
      const l = (d.label || "").toLowerCase();
      return !/front|user|facetime|trước/.test(l);
    });
    const list = (back.length ? back : cams).map(d => {
      const l = (d.label || "").toLowerCase();
      let kind = "wide", zoomFactor = 1;
      if (/ultra|0\.5|wide-angle/.test(l)) { kind = "ultra"; zoomFactor = 0.5; }
      else if (/tele|telephoto|2x|3x|5x/.test(l)) {
        kind = "tele";
        const m = l.match(/(\d)x/); zoomFactor = m ? Number(m[1]) : 2;
      }
      return { deviceId: d.deviceId, label: d.label, kind, zoomFactor };
    });
    // sắp xếp theo zoomFactor tăng dần, loại trùng
    list.sort((a, b) => a.zoomFactor - b.zoomFactor);
    store.lenses = list;
    return list;
  } catch {
    store.lenses = [];
    return [];
  }
}

// -------- Đọc đầy đủ getCapabilities() --------
export function setupCapabilities() {
  const track = store.videoTrack;
  store.caps = {};
  store.trackSettings = {};
  if (!track || !track.getCapabilities) return store.caps;

  let caps = {}, settings = {};
  try { caps = track.getCapabilities(); } catch {}
  try { settings = track.getSettings ? track.getSettings() : {}; } catch {}
  store.caps = caps;
  store.trackSettings = settings;

  // Lấy nét liên tục mặc định
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
    track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }
  return caps;
}

// Trợ giúp: cap có phải range dùng được không
export function hasRange(cap) {
  return cap && typeof cap.max === "number" && typeof cap.min === "number" && cap.max > cap.min;
}

// -------- Zoom (phần cứng nếu có, không thì zoom số) --------
export async function applyZoom(value) {
  const track = store.videoTrack;
  const caps = store.caps;
  if (track && hasRange(caps.zoom)) {
    const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, value));
    try { await track.applyConstraints({ advanced: [{ zoom: z }] }); store.digitalZoom = 1; return z; } catch {}
  }
  // fallback: zoom số bằng CSS transform trên video
  store.digitalZoom = Math.max(1, value);
  const v = store.el.video;
  const base = store.currentFacing === "user" && store.settings.mirrorSelfie ? "scaleX(-1) " : "";
  v.style.transform = base + `scale(${store.digitalZoom})`;
  return store.digitalZoom;
}

// -------- Torch / đèn flash liên tục --------
export async function setTorch(on) {
  const track = store.videoTrack;
  if (!track || !store.caps.torch) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    store.torchOn = !!on;
    return true;
  } catch { return false; }
}

// Chớp torch quanh lúc chụp (flash "on" ở mode thường)
export async function flashPulse(ms = 300) {
  if (!store.caps.torch) return;
  await setTorch(true);
  await new Promise(r => setTimeout(r, ms));
  await setTorch(false);
}

// -------- Exposure compensation (EV) --------
export async function applyEV(value) {
  const track = store.videoTrack;
  const cap = store.caps.exposureCompensation;
  if (!track || !hasRange(cap)) return false;
  const v = Math.min(cap.max, Math.max(cap.min, value));
  try {
    // exposureMode phải là 'continuous' để EV có tác dụng ở nhiều máy
    await track.applyConstraints({ advanced: [{ exposureCompensation: v }] });
    store.ev = v;
    return true;
  } catch { return false; }
}

// -------- Tap-to-focus: pointsOfInterest + single-shot, tự về continuous sau 3s --------
let focusTimer = null;
export async function tapFocus(clientX, clientY) {
  const track = store.videoTrack;
  const overlay = store.el.overlay, video = store.el.video;
  if (!track) return;

  const rect = overlay.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;

  // Hiện focus ring tại điểm chạm
  showFocusRing(px, py);

  const caps = store.caps;
  const advanced = [];
  if (Array.isArray(caps.pointsOfInterest) || caps.pointsOfInterest) {
    const norm = canvasPointToVideoNorm(px, py, video, overlay);
    advanced.push({ pointsOfInterest: [{ x: norm.x, y: norm.y }] });
  }
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes("single-shot")) {
    advanced.push({ focusMode: "single-shot" });
  } else if (Array.isArray(caps.focusMode) && caps.focusMode.includes("manual")) {
    advanced.push({ focusMode: "manual" });
  }
  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); } catch {}
  }

  // Sau 3s không tương tác → trả lại continuous
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    hideEVTrack();
  }, 3000);
}

function showFocusRing(px, py) {
  const ring = store.el.focusRing;
  if (!ring) return;
  ring.style.left = px + "px";
  ring.style.top = py + "px";
  ring.classList.remove("show");
  void ring.offsetWidth; // reflow để restart animation
  ring.classList.add("show");
  // Hiện thanh EV cạnh focus ring nếu hỗ trợ
  if (hasRange(store.caps.exposureCompensation)) showEVTrack(px, py);
}

// -------- Thanh EV dọc cạnh focus ring (☀️) --------
function showEVTrack(px, py) {
  const t = store.el.evTrack;
  if (!t) return;
  const overlay = store.el.overlay;
  // đặt bên phải ring, kẹp trong màn
  let left = px + 46;
  if (left > overlay.width - 40) left = px - 60;
  t.style.left = left + "px";
  t.style.top = py + "px";
  t.classList.add("show");
  positionSun();
}
function hideEVTrack() { store.el.evTrack && store.el.evTrack.classList.remove("show"); }

function positionSun() {
  const cap = store.caps.exposureCompensation;
  const sun = store.el.evSun;
  if (!sun || !hasRange(cap)) return;
  const range = cap.max - cap.min;
  const frac = range ? (store.ev - cap.min) / range : 0.5;
  // top = 0 (sáng, EV max) → 160 (tối, EV min): đảo cho trực giác kéo lên = sáng
  sun.style.top = (160 * (1 - frac)) + "px";
}

// Kéo dọc trên thanh EV
export function bindEVDrag() {
  const t = store.el.evTrack;
  if (!t) return;
  let dragging = false;
  const onMove = (clientY) => {
    const cap = store.caps.exposureCompensation;
    if (!hasRange(cap)) return;
    const r = t.getBoundingClientRect();
    let frac = 1 - (clientY - r.top) / r.height; // trên = sáng
    frac = Math.min(1, Math.max(0, frac));
    const val = cap.min + frac * (cap.max - cap.min);
    applyEV(val);
    positionSun();
    clearTimeout(focusTimer);
    focusTimer = setTimeout(hideEVTrack, 3000);
  };
  t.addEventListener("pointerdown", e => { dragging = true; t.setPointerCapture(e.pointerId); onMove(e.clientY); });
  t.addEventListener("pointermove", e => { if (dragging) onMove(e.clientY); });
  t.addEventListener("pointerup", () => { dragging = false; });
}

// -------- Tỉ lệ khung: cập nhật mask đen letterbox trên preview --------
export function applyAspectMask() {
  const stage = store.el.stage;
  if (!stage) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  const { maskTop, maskBottom, maskLeft, maskRight } = store.el;
  [maskTop, maskBottom, maskLeft, maskRight].forEach(m => { if (m) { m.style.height = "0px"; m.style.width = "0px"; } });

  const ratios = { "4:3": 3 / 4, "16:9": 9 / 16, "1:1": 1 };
  // preview dọc: tỉ lệ = width/height mong muốn (dọc). Chuyển sang chiều cao khung.
  // Ta hiển thị khung có tỉ lệ (rộng:cao). Với dọc: 3:4 => cao hơn rộng.
  const map = { "4:3": 4 / 3, "16:9": 16 / 9, "1:1": 1 }; // cao/rộng khi dọc
  const targetH = W * map[store.aspect];
  if (targetH <= H) {
    const pad = (H - targetH) / 2;
    if (maskTop) maskTop.style.height = pad + "px";
    if (maskBottom) maskBottom.style.height = pad + "px";
  } else {
    const targetW = H / map[store.aspect];
    const pad = (W - targetW) / 2;
    if (maskLeft) maskLeft.style.width = pad + "px";
    if (maskRight) maskRight.style.width = pad + "px";
  }
}

// -------- Pinch-to-zoom (Pointer Events) --------
export function bindPinchZoom() {
  const stage = store.el.stage;
  if (!stage) return;
  const pointers = new Map();
  let startDist = 0, startZoom = 1;

  stage.addEventListener("pointerdown", e => {
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      startDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      startZoom = currentZoomValue();
    }
  });
  stage.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2 && startDist > 0) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      const factor = dist / startDist;
      setZoomUI(startZoom * factor);
    }
  });
  const clear = e => { pointers.delete(e.pointerId); if (pointers.size < 2) startDist = 0; };
  stage.addEventListener("pointerup", clear);
  stage.addEventListener("pointercancel", clear);
}

function currentZoomValue() {
  const caps = store.caps;
  if (hasRange(caps.zoom)) {
    const s = store.videoTrack.getSettings ? store.videoTrack.getSettings() : {};
    return s.zoom || caps.zoom.min || 1;
  }
  return store.digitalZoom;
}

// Cập nhật cả zoom slider lẫn phần cứng
export async function setZoomUI(value) {
  const caps = store.caps;
  const zoomInput = store.el.zoom, zoomVal = store.el.zoomVal;
  let display = value;
  if (hasRange(caps.zoom)) {
    const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, value));
    await applyZoom(z);
    display = z;
    if (zoomInput) zoomInput.value = z;
  } else {
    const z = Math.min(6, Math.max(1, value));
    await applyZoom(z);
    display = z;
    if (zoomInput) zoomInput.value = z;
  }
  if (zoomVal) zoomVal.textContent = Number(display).toFixed(1) + "x";
}
