/* =========================================================
 * ai-smooth.js — Làm mượt & ổn định AI theo thời gian
 * SubjectTracker: chọn chủ thể tốt nhất, match IoU giữa các frame,
 *   làm mượt box bằng EMA, đánh giá "đứng yên" (stable).
 * GuidanceStabilizer: hysteresis cho chữ hướng dẫn — chỉ đổi sau N raw
 *   state giống nhau liên tiếp → hết nhấp nháy.
 * ========================================================= */

export class SubjectTracker {
  constructor({ priority, alpha = 0.35, iouThresh = 0.3, lostMs = 600, stableWindow = 10, stableFrac = 0.02 } = {}) {
    this.priority = priority || new Set();
    this.alpha = alpha;
    this.iouThresh = iouThresh;
    this.lostMs = lostMs;
    this.stableWindow = stableWindow;
    this.stableFrac = stableFrac;
    this.box = null;        // box đã mượt {x,y,w,h} theo px video
    this.label = "";
    this.lastSeen = -1e9;
    this.centers = [];      // tâm chuẩn hoá gần đây (đo stable)
  }

  _score(d) {
    const b = d.boundingBox; if (!b) return -1;
    const label = (d.categories && d.categories[0] && d.categories[0].categoryName) || "";
    return b.width * b.height * (this.priority.has(label) ? 3 : 1);
  }

  // detections: mảng MediaPipe detection (boundingBox theo px video)
  update(detections, tsMs, frameW = 0, frameH = 0) {
    let best = null, bestScore = -1, bestLabel = "";
    if (detections) for (const d of detections) {
      const s = this._score(d);
      if (s > bestScore) {
        bestScore = s; best = d;
        bestLabel = (d.categories && d.categories[0] && d.categories[0].categoryName) || "";
      }
    }

    if (!best) {
      if (this.box && tsMs - this.lastSeen > this.lostMs) this._reset();
      return this.box ? this._out() : null;
    }

    const bb = best.boundingBox;
    const raw = { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height };

    if (this.box && (tsMs - this.lastSeen) <= this.lostMs && this._iou(this.box, raw) > this.iouThresh) {
      const a = this.alpha;
      this.box = {
        x: this.box.x + (raw.x - this.box.x) * a,
        y: this.box.y + (raw.y - this.box.y) * a,
        w: this.box.w + (raw.w - this.box.w) * a,
        h: this.box.h + (raw.h - this.box.h) * a,
      };
    } else {
      // chủ thể mới hoặc mất quá lâu → snap, không nhảy IoU mỗi frame
      this.box = raw;
      this.centers = [];
    }
    this.label = bestLabel;
    this.lastSeen = tsMs;

    const cx = this.box.x + this.box.w / 2, cy = this.box.y + this.box.h / 2;
    const nx = frameW ? cx / frameW : cx, ny = frameH ? cy / frameH : cy;
    this.centers.push({ nx, ny });
    if (this.centers.length > this.stableWindow) this.centers.shift();
    return this._out();
  }

  _out() { return { box: this.box, label: this.label, stable: this._isStable() }; }

  _isStable() {
    if (this.centers.length < this.stableWindow) return false;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const c of this.centers) {
      if (c.nx < minx) minx = c.nx; if (c.nx > maxx) maxx = c.nx;
      if (c.ny < miny) miny = c.ny; if (c.ny > maxy) maxy = c.ny;
    }
    return (maxx - minx) < this.stableFrac && (maxy - miny) < this.stableFrac;
  }

  _iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = Math.max(0, x2 - x1), ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    const uni = a.w * a.h + b.w * b.h - inter;
    return uni > 0 ? inter / uni : 0;
  }

  _reset() { this.box = null; this.label = ""; this.centers = []; this.lastSeen = -1e9; }
}

// -------- Hysteresis cho chữ hướng dẫn --------
// raw/displayed: "left"|"right"|"up"|"down"|"good"|"none"
export class GuidanceStabilizer {
  constructor({ confirm = 3 } = {}) {
    this.confirm = confirm;
    this.displayed = "none";
    this.candidate = null;
    this.count = 0;
  }

  update(raw) {
    // Từ trạng thái trống → nhận ngay raw đầu tiên (tránh "kẹt" lúc mới thấy chủ thể)
    if (this.displayed === "none" && raw !== "none") {
      this.displayed = raw; this.candidate = null; this.count = 0;
      return this.displayed;
    }
    if (raw === this.displayed) { this.candidate = null; this.count = 0; return this.displayed; }
    if (raw === this.candidate) {
      this.count++;
      if (this.count >= this.confirm) { this.displayed = raw; this.candidate = null; this.count = 0; }
    } else {
      this.candidate = raw; this.count = 1;
    }
    return this.displayed;
  }

  reset() { this.displayed = "none"; this.candidate = null; this.count = 0; }
}
