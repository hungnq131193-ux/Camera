/* =========================================================
 * composition.js — Thuật toán bố cục 1/3 (giữ nguyên từ bản gốc)
 * Chỉ tách thành module; logic toán học không đổi.
 * ========================================================= */
import { store } from "./state.js";

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

// Xử lý danh sách detection → chỉ dẫn bố cục. Trả về true nếu bố cục "đẹp".
export function handleComposition(detections, ctx) {
  const { octx, overlay, video, updateGuide } = ctx;
  const PRIORITY = new Set(["person","cat","dog","bird","horse","sheep","cow","bear","elephant"]);
  let best = null, bestScore = -1;
  for (const d of detections) {
    const box = d.boundingBox;
    if (!box) continue;
    const label = (d.categories && d.categories[0] && d.categories[0].categoryName) || "";
    const area  = box.width * box.height;
    const score = area * (PRIORITY.has(label) ? 3 : 1);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (!best) { updateGuide("Hướng máy vào chủ thể…", "neutral"); return false; }

  const rect = videoToCanvas(best.boundingBox, video, overlay);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  const W = overlay.width, H = overlay.height;
  const gx = [W / 3, (2 * W) / 3];
  const gy = [H / 3, (2 * H) / 3];

  let target = null, minDist = Infinity;
  for (const px of gx) for (const py of gy) {
    const dist = Math.hypot(cx - px, cy - py);
    if (dist < minDist) { minDist = dist; target = { px, py }; }
  }

  const dx = target.px - cx;
  const dy = target.py - cy;
  const snapX = W * 0.08;
  const snapY = H * 0.08;
  const okX = Math.abs(dx) <= snapX;
  const okY = Math.abs(dy) <= snapY;
  const good = okX && okY;

  drawBox(octx, rect, good);
  drawTargetPoints(octx, gx, gy, target);

  if (good) {
    updateGuide("✔ Bố cục đẹp — Chụp ngay!", "good");
    drawBorder(octx, overlay, true);
  } else {
    let msg;
    if (Math.abs(dx) / snapX >= Math.abs(dy) / snapY) {
      msg = dx > 0 ? "Đưa máy sang trái ⬅️" : "Đưa máy sang phải ➡️";
    } else {
      msg = dy > 0 ? "Đưa máy lên trên ⬆️" : "Đưa máy xuống dưới ⬇️";
    }
    updateGuide(msg, "adjust");
  }
  return good;
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

// Vẽ khung mặt (mode Chân dung)
export function drawFaces(octx, faces, video, overlay) {
  octx.save();
  octx.strokeStyle = "rgba(255,214,10,0.9)";
  octx.lineWidth = 2.5;
  for (const f of faces) {
    const box = f.boundingBox;
    if (!box) continue;
    const r = videoToCanvas(box, video, overlay);
    // bo góc nhẹ
    const rad = 10;
    octx.beginPath();
    octx.moveTo(r.x + rad, r.y);
    octx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
    octx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
    octx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
    octx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
    octx.stroke();
  }
  octx.restore();
}
