/* =========================================================
 * composition.js — Thuật toán bố cục 1/3 (giữ nguyên từ bản gốc)
 * Chỉ tách thành module; logic toán học không đổi.
 * ========================================================= */
import { store } from "./state.js";
import { SubjectTracker, GuidanceStabilizer } from "./ai-smooth.js";

const PRIORITY = new Set(["person", "cat", "dog", "bird", "horse", "sheep", "cow", "bear", "elephant"]);

// -------- State làm mượt (module-level) --------
const objectTracker = new SubjectTracker({ priority: PRIORITY });
const faceTracker = new SubjectTracker({ alpha: 0.4 });
const guideStab = new GuidanceStabilizer({ confirm: 3 });
let goodActive = false;                 // latch hysteresis cho "good"
let compState = { hasSubject: false, box: null, good: false, stable: false };
let faceState = { has: false, box: null };
let drawnBox = null;                    // box đang vẽ (video coords) — lerp mỗi frame
let drawnFace = null;

// Vẽ 2 đường dọc + 2 đường ngang chia khung thành 9 phần
export function drawRuleOfThirds(octx, overlay) {
  const W = overlay.width, H = overlay.height;
  octx.save();
  octx.strokeStyle = "rgba(255,255,255,0.32)";
  octx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const x = (W / 3) * i, y = (H / 3) * i;
    octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, H); octx.stroke();
    octx.beginPath(); octx.moveTo(0, y); octx.lineTo(W, y); octx.stroke();
  }
  octx.restore();
}

// Quy đổi toạ độ pixel video → pixel canvas hiển thị (xử lý object-fit: cover)
export function videoToCanvas(bbox, video, overlay) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = overlay.width,    ch = overlay.height;
  const scale = Math.max(cw / vw, ch / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2;

  let x = bbox.originX * scale + offX;
  let y = bbox.originY * scale + offY;
  let w = bbox.width  * scale;
  let h = bbox.height * scale;

  if (store.currentFacing === "user") {
    x = cw - (x + w);
  }
  return { x, y, w, h };
}

// Nghịch đảo: điểm trên canvas (CSS px) → toạ độ chuẩn hoá [0,1] trên video
// Dùng cho tap-to-focus (pointsOfInterest cần toạ độ theo hệ sensor video).
export function canvasPointToVideoNorm(px, py, video, overlay) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = overlay.width,    ch = overlay.height;
  const scale = Math.max(cw / vw, ch / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2;

  let cx = px;
  if (store.currentFacing === "user") cx = cw - px;  // lật gương

  let nx = (cx - offX) / dispW;
  let ny = (py - offY) / dispH;
  nx = Math.min(1, Math.max(0, nx));
  ny = Math.min(1, Math.max(0, ny));
  return { x: nx, y: ny };
}

// Xử lý (12Hz): tracker + hysteresis → cập nhật guide + state. Trả về good ổn định.
export function handleComposition(detections, ctx, tsMs) {
  const { overlay, video, updateGuide } = ctx;
  const sub = objectTracker.update(detections, tsMs, video.videoWidth, video.videoHeight);

  if (!sub || !sub.box) {
    compState = { hasSubject: false, box: null, good: false, stable: false };
    goodActive = false;
    guideStab.update("none");
    updateGuide("Hướng máy vào chủ thể…", "neutral");
    return false;
  }

  const rect = boxToCanvas(sub.box, video, overlay);
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const W = overlay.width, H = overlay.height;
  const gx = [W / 3, (2 * W) / 3], gy = [H / 3, (2 * H) / 3];

  let target = null, minDist = Infinity;
  for (const px of gx) for (const py of gy) {
    const dist = Math.hypot(cx - px, cy - py);
    if (dist < minDist) { minDist = dist; target = { px, py }; }
  }
  const dx = target.px - cx, dy = target.py - cy;

  // Hysteresis "good": vào khi lệch ≤8%, ra chỉ khi >11%
  const enter = Math.abs(dx) <= W * 0.08 && Math.abs(dy) <= H * 0.08;
  const exit  = Math.abs(dx) <= W * 0.11 && Math.abs(dy) <= H * 0.11;
  goodActive = goodActive ? exit : enter;

  let raw;
  if (goodActive) raw = "good";
  else if (Math.abs(dx) / (W * 0.08) >= Math.abs(dy) / (H * 0.08))
    raw = dx > 0 ? "left" : "right";
  else raw = dy > 0 ? "up" : "down";

  const disp = guideStab.update(raw);
  const goodDisp = disp === "good";
  compState = { hasSubject: true, box: sub.box, good: goodDisp, stable: sub.stable };

  if (goodDisp) {
    updateGuide(sub.stable ? "✔ Bố cục đẹp — giữ chắc tay!" : "✔ Bố cục đẹp — Chụp ngay!", "good");
  } else {
    updateGuide({
      left: "Đưa máy sang trái ⬅️",
      right: "Đưa máy sang phải ➡️",
      up: "Đưa máy lên trên ⬆️",
      down: "Đưa máy xuống dưới ⬇️",
    }[disp] || "Căn chỉnh bố cục…", "adjust");
  }
  return goodActive && sub.stable;
}

// Chuyển box (video px) → rect canvas
function boxToCanvas(b, video, overlay) {
  return videoToCanvas({ originX: b.x, originY: b.y, width: b.w, height: b.h }, video, overlay);
}

// Vẽ overlay bố cục MỖI rAF frame từ state (box lướt mượt bằng lerp)
export function drawCompositionOverlay(octx, overlay, video) {
  if (!compState.hasSubject || !compState.box) { drawnBox = null; return; }
  // lerp box vẽ → target (mượt hơn 12Hz detect)
  const t = compState.box;
  if (!drawnBox) drawnBox = { ...t };
  else {
    const k = 0.4;
    drawnBox.x += (t.x - drawnBox.x) * k;
    drawnBox.y += (t.y - drawnBox.y) * k;
    drawnBox.w += (t.w - drawnBox.w) * k;
    drawnBox.h += (t.h - drawnBox.h) * k;
  }
  const rect = boxToCanvas(drawnBox, video, overlay);
  const W = overlay.width, H = overlay.height;
  const gx = [W / 3, (2 * W) / 3], gy = [H / 3, (2 * H) / 3];
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  let target = null, minDist = Infinity;
  for (const px of gx) for (const py of gy) {
    const dist = Math.hypot(cx - px, cy - py);
    if (dist < minDist) { minDist = dist; target = { px, py }; }
  }
  drawBox(octx, rect, compState.good);
  drawTargetPoints(octx, gx, gy, target);
  if (compState.good) drawBorder(octx, overlay, true);
}

export function resetComposition() {
  compState = { hasSubject: false, box: null, good: false, stable: false };
  faceState = { has: false, box: null };
  drawnBox = null; drawnFace = null; goodActive = false;
  guideStab.reset();
}

function drawBox(octx, rect, good) {
  octx.save();
  octx.strokeStyle = good ? "#22c55e" : "#facc15";
  octx.lineWidth = 3;
  octx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  octx.fillStyle = good ? "#22c55e" : "#facc15";
  octx.beginPath();
  octx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, 5, 0, Math.PI * 2);
  octx.fill();
  octx.restore();
}

function drawTargetPoints(octx, gx, gy, target) {
  octx.save();
  for (const px of gx) for (const py of gy) {
    const isTarget = target && px === target.px && py === target.py;
    octx.beginPath();
    octx.arc(px, py, isTarget ? 8 : 4, 0, Math.PI * 2);
    octx.fillStyle = isTarget ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.5)";
    octx.fill();
  }
  octx.restore();
}

function drawBorder(octx, overlay, good) {
  if (!good) return;
  octx.save();
  octx.strokeStyle = "#22c55e";
  octx.lineWidth = 6;
  octx.strokeRect(3, 3, overlay.width - 6, overlay.height - 6);
  octx.restore();
}

// Cập nhật tracker mặt (12Hz) — theo top-1 face
export function updateFaces(detections, tsMs, video) {
  const sub = faceTracker.update(detections, tsMs, video.videoWidth, video.videoHeight);
  faceState = sub && sub.box ? { has: true, box: sub.box } : { has: false, box: null };
  return faceState.has;
}

// Vẽ khung mặt mỗi rAF frame (box lướt mượt)
export function drawFaceOverlay(octx, overlay, video) {
  if (!faceState.has || !faceState.box) { drawnFace = null; return; }
  const t = faceState.box;
  if (!drawnFace) drawnFace = { ...t };
  else {
    const k = 0.4;
    drawnFace.x += (t.x - drawnFace.x) * k;
    drawnFace.y += (t.y - drawnFace.y) * k;
    drawnFace.w += (t.w - drawnFace.w) * k;
    drawnFace.h += (t.h - drawnFace.h) * k;
  }
  const r = boxToCanvas(drawnFace, video, overlay);
  const rad = 10;
  octx.save();
  octx.strokeStyle = "rgba(255,214,10,0.9)";
  octx.lineWidth = 2.5;
  octx.beginPath();
  octx.moveTo(r.x + rad, r.y);
  octx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  octx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  octx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  octx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  octx.stroke();
  octx.restore();
}
