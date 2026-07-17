/* =========================================================
 * pipeline.js — Façade main-thread cho Web Worker xử lý ảnh
 * Feature-detect OffscreenCanvas + module worker, sở hữu worker,
 * map job id → Promise, expose enhanceInWorker() + isWorkerAvailable().
 * Fail (Safari cũ, không có OffscreenCanvas...) → cờ available=false,
 * caller dùng đường sync fallback (capturePhotoSync).
 * ========================================================= */

let worker = null;
let readyPromise = null;      // Promise<boolean>
let available = null;         // null = chưa dò, true/false = kết quả
let seq = 0;
let pendingCount = 0;
const pending = new Map();    // id → { resolve, reject }

function featureDetect() {
  return typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function" &&
    typeof Worker !== "undefined" &&
    typeof createImageBitmap !== "undefined";
}

function onWorkerMessage(e) {
  const msg = e.data;
  if (!msg || msg.kind === "pong") return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  pendingCount = Math.max(0, pendingCount - 1);
  if (msg.ok) entry.resolve({ blob: msg.blob, thumbBlob: msg.thumbBlob, width: msg.width, height: msg.height });
  else entry.reject(new Error(msg.error || "worker error"));
}

// Khởi tạo + handshake ping/pong (Safari <15 fail module worker âm thầm)
export function ready() {
  if (readyPromise) return readyPromise;
  if (!featureDetect()) {
    available = false;
    readyPromise = Promise.resolve(false);
    return readyPromise;
  }
  readyPromise = new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      available = ok;
      resolve(ok);
    };
    try {
      worker = new Worker(new URL("./worker/enhance-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = onWorkerMessage;
      worker.onerror = (ev) => { console.warn("[pipeline] worker error:", ev.message || ev); done(false); };
      const timeout = setTimeout(() => done(false), 3000);
      const onPong = (e) => {
        if (e.data && e.data.kind === "pong") {
          clearTimeout(timeout);
          worker.removeEventListener("message", onPong);
          done(true);
        }
      };
      worker.addEventListener("message", onPong);
      worker.postMessage({ kind: "ping" });
    } catch (err) {
      console.warn("[pipeline] không tạo được worker:", err);
      done(false);
    }
  });
  return readyPromise;
}

export function isWorkerAvailable() { return available === true; }
export function pendingJobs() { return pendingCount; }

// job: { kind, bitmap?|bitmaps?, mode?, autoEnhance?, jpegQuality?, mask?, portraitBlur? }
// bitmap/bitmaps/mask.buf luôn nằm trong transfer list.
export function enhanceInWorker(job) {
  if (available !== true || !worker) return Promise.reject(new Error("worker unavailable"));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    pendingCount++;
    const transfer = [];
    if (job.bitmap) transfer.push(job.bitmap);
    if (Array.isArray(job.bitmaps)) transfer.push(...job.bitmaps);
    if (job.mask && job.mask.buf) transfer.push(job.mask.buf);
    try {
      worker.postMessage({ id, ...job }, transfer);
    } catch (err) {
      pending.delete(id);
      pendingCount = Math.max(0, pendingCount - 1);
      reject(err);
    }
  });
}
