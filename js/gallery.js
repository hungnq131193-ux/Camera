/* =========================================================
 * gallery.js — Thư viện trong app (IndexedDB)
 * store photos: {id, blob, thumbBlob, type, mode, ts}
 * ========================================================= */
import { store } from "./state.js";

const DB_NAME = "camera-gallery";
const STORE = "photos";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Tạo thumbnail 256px từ blob ảnh/video
async function makeThumb(blob, type) {
  try {
    let source;
    if (type === "video") {
      source = await grabVideoFrame(blob);
    } else {
      source = await createImageBitmap(blob);
    }
    const size = 256;
    const w = source.width, h = source.height;
    const scale = size / Math.min(w, h);
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    const dw = w * scale, dh = h * scale;
    ctx.drawImage(source, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return await new Promise(r => c.toBlob(r, "image/jpeg", 0.8));
  } catch { return blob; }
}

function grabVideoFrame(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true;
    v.src = URL.createObjectURL(blob);
    v.onloadeddata = () => { v.currentTime = Math.min(0.1, v.duration || 0.1); };
    v.onseeked = () => { resolve(v); };
    v.onerror = reject;
  });
}

export async function saveMedia({ blob, type = "photo", mode = "photo", id, ts, thumbBlob, pending = false }) {
  const db = await openDB();
  // Chỉ decode lại blob để tạo thumb khi KHÔNG được cấp sẵn (đường video)
  const finalThumb = thumbBlob || await makeThumb(blob, type);
  const item = {
    id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    blob, thumbBlob: finalThumb, type, mode,
    ts: ts || Date.now(),
    pending: !!pending,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  checkStorage();
  return item;
}

// Cập nhật đè 1 record (worker trả blob/thumb cuối) trong 1 transaction
export async function updateMedia(id, patch) {
  const db = await openDB();
  const item = await getOne(id);
  if (!item) return null;
  const updated = { ...item, ...patch };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(updated);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return updated;
}

export async function getAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts));
    req.onerror = () => reject(req.error);
  });
}

export async function getOne(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function latest() {
  const all = await getAll();
  return all[0] || null;
}

// Xin quyền lưu bền + cảnh báo sắp đầy
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch {}
}

export async function checkStorage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (quota && usage / quota > 0.9 && store.el.toast) {
        store.el.toast("⚠️ Bộ nhớ sắp đầy — hãy xoá bớt ảnh trong thư viện.");
      }
    }
  } catch {}
}
