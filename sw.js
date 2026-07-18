/* =========================================================
 * Service Worker — Camera AI Bố cục
 * Mục tiêu: OFFLINE TUYỆT ĐỐI sau lần mở đầu tiên có mạng.
 * Cache cả app shell + Tailwind CDN + MediaPipe (JS/WASM) + model.
 * ========================================================= */

const CACHE = "camera-ai-v5";

// Phiên bản MediaPipe (phải khớp với js/state.js để cache đúng file)
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22";

// Danh sách precache: cố gắng tải sẵn ngay khi install (lúc còn mạng).
// Một số file phụ của WASM do MediaPipe tự request runtime sẽ được
// "runtime caching" trong sự kiện fetch bắt bổ sung.
const PRECACHE_URLS = [
  // ----- App shell (đường dẫn tương đối để chạy trên GitHub Pages subpath) -----
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",

  // ----- CSS -----
  "./css/app.css",

  // ----- ES Modules -----
  "./js/main.js",
  "./js/state.js",
  "./js/camera.js",
  "./js/composition.js",
  "./js/ai.js",
  "./js/enhance.js",
  "./js/enhance-core.js",
  "./js/pipeline.js",
  "./js/download.js",
  "./js/worker/enhance-worker.js",
  "./js/worker/night.js",
  "./js/ai-smooth.js",
  "./js/modes.js",
  "./js/capture.js",
  "./js/gallery.js",
  "./js/ui.js",

  // ----- Tailwind CDN -----
  "https://cdn.tailwindcss.com",

  // ----- MediaPipe Tasks Vision: JS bundle (ESM) -----
  MP,
  MP + "/vision_bundle.mjs",

  // ----- MediaPipe WASM (glue JS + nhị phân) -----
  MP + "/wasm/vision_wasm_internal.js",
  MP + "/wasm/vision_wasm_internal.wasm",
  MP + "/wasm/vision_wasm_nosimd_internal.js",
  MP + "/wasm/vision_wasm_nosimd_internal.wasm",

  // ----- Model Object Detection (EfficientDet-Lite2 float16) -----
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite",

  // ----- Model Face Detection (BlazeFace short-range float16) -----
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",

  // ----- Model Image Segmenter (SelfieSegmenter float16) -----
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
];

// -------- INSTALL: precache từng URL, bọc try/catch để 1 file lỗi không phá cả install --------
self.addEventListener("install", (event) => {
  self.skipWaiting(); // kích hoạt SW mới ngay
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        // Dùng cors khi cùng nguồn hoặc CDN hỗ trợ; fallback no-cors (opaque) nếu bị chặn
        let req = new Request(url, { mode: "cors", credentials: "omit" });
        let res = await fetch(req);
        if (!res || (!res.ok && res.type !== "opaque")) {
          // Thử lại no-cors → lấy response opaque vẫn cache được
          res = await fetch(new Request(url, { mode: "no-cors", credentials: "omit" }));
        }
        if (res) await cache.put(url, res.clone());
      } catch (err) {
        // Bỏ qua file lỗi (ví dụ file nosimd không tồn tại) — không phá install
        console.warn("[SW] precache bỏ qua:", url, err);
      }
    }));
  })());
});

// -------- ACTIVATE: xoá cache version cũ + claim clients --------
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// -------- FETCH: Cache-first + runtime caching --------
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Chỉ xử lý GET (POST/PUT… bỏ qua)
  if (req.method !== "GET") return;

  // Navigation request (mở trang) → khi offline fallback về index.html
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        // Ghi bổ sung vào cache để lần sau offline vẫn có
        const cache = await caches.open(CACHE);
        cache.put(req, net.clone()).catch(() => {});
        return net;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match("./index.html")) ||
               (await cache.match("./")) ||
               Response.error();
      }
    })());
    return;
  }

  // Các request tài nguyên khác → Cache-first, miss thì fetch mạng rồi ghi bổ sung
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) return cached;

    try {
      // Cho phép cả cors lẫn opaque (no-cors) để bắt file phụ của MediaPipe
      const net = await fetch(req);
      // Cache lại cả response opaque (type === "opaque") để offline dùng được
      if (net && (net.ok || net.type === "opaque")) {
        cache.put(req, net.clone()).catch(() => {});
      }
      return net;
    } catch (err) {
      // Hết cách: thử match lỏng (bỏ query) trước khi trả lỗi
      const loose = await cache.match(req, { ignoreSearch: true });
      return loose || Response.error();
    }
  })());
});
