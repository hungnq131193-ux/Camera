# PLAN NÂNG CẤP CAMERA AI — Hướng dẫn chi tiết cho Opus 4.8

> Tài liệu này là bản kế hoạch thi công chi tiết. Người thực hiện (Opus 4.8) làm theo **từng phase theo thứ tự A → B → C**, mỗi bước nhỏ là 1 commit riêng, mỗi phase có checklist kiểm thử riêng và có thể ship độc lập.

## 0. Bối cảnh & mục tiêu

**3 vấn đề người dùng nêu:**
1. **Lưu ảnh sau khi chụp quá lâu** → cần lưu "tức thì" như app camera thường, VÀ tự động lưu ảnh vào bộ sưu tập của máy (đã chốt phương án: tự động tải JPEG về thư mục **Downloads** — ảnh sẽ hiện trong app Thư viện/Google Photos).
2. **AI hoạt động chưa tốt** → hướng dẫn bố cục nhấp nháy, khung nhận diện giật, cần mượt và chính xác hơn.
3. **Tích hợp kỹ thuật kiểu PhotonCamera** (https://github.com/eszdman/PhotonCamera) → PhotonCamera là app **Android native** (Camera2 API, RAW, GLSL shader) nên KHÔNG thể port trực tiếp. Đã chốt: **giữ PWA, mô phỏng các kỹ thuật cốt lõi** — night mode chụp burst + căn chỉnh (align) + ghép frame chống ghost kiểu HDR+, khử nhiễu, tone mapping, HDR bracketing, nâng cấp điều khiển Pro.

**Ràng buộc toàn cục:**
- Vanilla ES modules, **không build step**. Mọi file mới là ES module thuần, đường dẫn tương đối `./` (an toàn cho GitHub Pages subpath).
- Mọi thứ phải chạy **offline** (sw.js cache-first). Thêm file JS mới ⇒ phải thêm vào `PRECACHE_URLS` và **bump tên cache**, nếu không offline hỏng âm thầm.
- **Ràng buộc phiên bản MediaPipe**: version hardcode ở CẢ `js/state.js:79` (`MP_VER`) và `sw.js:10` (`MP`) — đổi 1 chỗ phải đổi cả 2.
- Toàn bộ chuỗi UI mới bằng **tiếng Việt**.

## 1. Kiến trúc hiện tại & nguyên nhân chậm (đã xác minh trên HEAD 9c909d8)

**Đường đi chụp ảnh:** nút chụp → `onShutter()` (`js/ui.js:368`) → `capturePhoto()` (`js/capture.js:83`):
`grabFullFrame` (capture.js:43, `ImageCapture.takePhoto` → `createImageBitmap`, fallback canvas) → `limitSize` 4096px (enhance.js:20) → `cropAspect` (enhance.js:31) → pipeline mode (portrait: segment + bokeh capture.js:146; food/landscape: `applyModeFilter`) → `autoEnhance` (enhance.js:220) → mirror selfie → `canvas.toBlob` JPEG 0.92 → `saveMedia` (gallery.js:60, IndexedDB `camera-gallery`).

**Nguyên nhân chậm (tất cả chạy trên MAIN THREAD, vòng lặp per-pixel JS trên ảnh tới 4096px):**
- `autoEnhance` (enhance.js:220) chạy MỌI ảnh: autoLevels + grayWorldWB + vibrance + `unsharpMask`. `unsharpMask` gọi `boxBlur` → `blurPass` (enhance.js:186) là blur **ngây thơ O(w·h·r)** không có sliding-window (trong khi `blurAlpha` enhance.js:312 ĐÃ là sliding-window O(w·h) — dùng làm mẫu).
- `makeThumb` (gallery.js:29) **decode lại blob** để tạo thumbnail, và `saveMedia` `await` nó ⇒ thumbnail nằm trên critical path lưu ảnh.
- Portrait: segmentation + `portraitBokeh` (enhance.js:269, boxBlur ngây thơ radius 14) + `skinSmooth`.
- Night: 6 frame × 90ms gap (~450ms chỉ để grab) + `stackFrames` (enhance.js:362) cộng trung bình **không căn chỉnh** ⇒ nhòe/ghost khi cầm tay.
- Không Web Worker, không OffscreenCanvas; nhiều round-trip `getImageData`/`putImageData` thừa.

**AI hiện tại:** MediaPipe tasks-vision 0.10.14 (CDN jsDelivr, đã precache offline). ObjectDetector EfficientDet-Lite0 fp16 (ai.js:28) cho bố cục 1/3 (`handleComposition` composition.js:60), FaceDetector BlazeFace (ai.js:49), ImageSegmenter SelfieSegmenter (ai.js:67, category mask nhị phân). `renderLoop` (main.js:37) detect mỗi frame video mới, **không có smoothing/hysteresis** ⇒ chữ hướng dẫn nhấp nháy, khung giật; không giới hạn FPS detect ⇒ tranh CPU với UI.

---

## 2. Quyết định kiến trúc chung (áp dụng mọi phase)

**Tách enhance.js thành lõi thuần pixel (không DOM) + module Worker.**

### File mới `js/enhance-core.js`
Hàm pixel thuần, **KHÔNG import gì** (tuyệt đối không import `state.js` — nó đụng `localStorage`, throw trong worker). Chuyển nguyên văn từ enhance.js: `autoLevels`, `grayWorldWB`, `vibrance`, `contrast`, `saturation`, `warmTone`, `gamma`, `boxBlur`, `clamp255`, `buildPersonAlpha`, `blurAlpha`. Thêm các bản refactor nhận/trả ImageData (không nhận ctx):
- `unsharpMaskData(img, w, h, amount, radius)`
- `portraitBokehData(img, w, h, mask, maskW, maskH, blurRadius)`
- `skinSmoothData(img, w, h, alpha)`
- `stackFramesData(imageDatas)`
- `autoEnhanceData(img, w, h)` — chain autoLevels → grayWorldWB → vibrance → unsharp trên **MỘT** ImageData duy nhất (caller chỉ get/putImageData 1 lần).

### `js/enhance.js` (giữ lại)
Chỉ còn helper phụ thuộc DOM (`canvasFrom`, `limitSize`, `cropAspect`, `mirror`, `vignette`, `PREVIEW_FILTERS`) + wrapper mỏng main-thread (vd `autoEnhance(canvas)` = getImageData → `autoEnhanceData` → putImageData) — wrapper này là **đường fallback** cho trình duyệt không có module worker/OffscreenCanvas. Cập nhật import ở `capture.js` (modes.js chỉ import `PREVIEW_FILTERS` — không đổi).

### File mới `js/worker/enhance-worker.js`
Module worker: `import * as core from "../enhance-core.js";`. Dùng `OffscreenCanvas` + `convertToBlob`. Xử lý job tuần tự (hàng đợi message tự nhiên). Vẽ bitmap vào OffscreenCanvas → 1 lần `getImageData` → chain hàm core → 1 lần `putImageData` (riêng `vignette` cho food: vẽ lại bằng gradient 2D OffscreenCanvas, cùng code enhance.js:207) → `convertToBlob({type:"image/jpeg", quality})` → vẽ thêm thumb 256px center-crop → `convertToBlob` 0.8 → post cả 2 blob.

### File mới `js/pipeline.js`
Façade main-thread: feature-detect, sở hữu worker + map job, expose `enhanceInWorker(job) → Promise<{blob, thumbBlob}>` và `isWorkerAvailable()`. Feature detection: `typeof OffscreenCanvas !== "undefined" && "convertToBlob" in OffscreenCanvas.prototype && typeof Worker !== "undefined"`; probe module-worker bằng cách tạo worker và race handshake `{kind:"ping"}` → `"pong"` timeout ~3s (Safari <15 fail module worker âm thầm); fail ⇒ set cờ, dùng đường sync fallback. Tạo worker bằng `new Worker(new URL("./worker/enhance-worker.js", import.meta.url), {type:"module"})`.

### Giao thức worker (bitmap/buffer luôn nằm trong transfer list)
```
Main → Worker:
{ id, kind: "photo",  bitmap: ImageBitmap,            // đã limit/crop/mirror xong (hình học cuối)
  mode: "photo"|"landscape"|"food"|"portrait",
  autoEnhance: bool, jpegQuality: number,
  mask: { buf: ArrayBuffer, w, h } | null,            // chỉ portrait
  portraitBlur: number }
{ id, kind: "night",  bitmaps: ImageBitmap[], jpegQuality, autoEnhance }
{ id, kind: "hdr",    bitmaps: ImageBitmap[], jpegQuality }   // Phase C
{ kind: "ping" }

Worker → Main:
{ id, ok: true, blob: Blob, thumbBlob: Blob, width, height }
{ id, ok: false, error: string }   // main giữ bản quick-save
{ kind: "pong" }
```

---

## 3. PHASE A — Lưu ảnh tức thì + tự tải về máy (ưu tiên cao nhất)

**Quyết định chốt:** **quick-save ngay bản JPEG đúng hình học nhưng chưa enhance, rồi cập nhật ĐÈ cùng record IndexedDB khi worker xử lý xong.** Lý do: crop/mirror/downscale là `drawImage` GPU rẻ nên bản quick đã đúng khung hình; ảnh được lưu bền kể cả tab chết giữa chừng; nút chụp mở khóa ngay; id record không đổi nên gallery nhất quán. Auto-download chỉ bắn với **bản JPEG cuối** (hoặc ngay lập tức nếu không cần enhance).

### A1. Tạo `js/enhance-core.js` + `js/worker/enhance-worker.js` + `js/pipeline.js`
Như mục 2. Port `stackFrames` (enhance.js:362) thành `stackFramesData` (Phase A giữ cộng trung bình ngây thơ — alignment để Phase C — nhưng giờ chạy trong worker nên UI không đơ nữa).

### A2. Blur nhanh — viết lại `blurPass` (enhance.js:186 → chuyển vào enhance-core.js)
Viết lại 2 pass của `boxBlur` theo pattern **sliding-window accumulator** đã có sẵn ở `blurAlpha` (enhance.js:312-339): mỗi hàng (rồi mỗi cột), khởi tạo sum trên `[-r, r]` với clamp biên, sau đó mỗi pixel: emit `sum/div`, cộng mẫu vào, trừ mẫu ra. Làm 4 kênh với 4 biến sum chạy song song. Độ phức tạp O(w·h·r) → O(w·h) — với bokeh radius 14 là ~29× ít phép tính hơn, là **thắng lợi CPU lớn nhất** (bokeh chân dung, skin smooth, unsharp, night unsharp đều gọi nó). Giữ đúng ngữ nghĩa clamp biên của blurAlpha để output khớp. Sanity test: blur ảnh hằng số phải ra chính nó.

### A3. Tái cấu trúc `capturePhoto` (capture.js:83)
Luồng mới:
1. **Đồng bộ ngay khi chạm** (trước mọi `await`): `shutterSound()`, `doFlash()`, vibrate, và **thumbnail đóng băng tức thì** — helper mới `quickPreviewFromVideo()`: vẽ `store.el.video` vào canvas ~256px (áp `cropAspect` + mirror selfie trên canvas nhỏ — rẻ), `toBlob(0.7)` → set ảnh `galleryThumb` ngay + `setThumbProcessing(true)`. Người dùng thấy "đã chụp" trong <50ms như camera native.
2. Sinh `const id = crypto.randomUUID()`, `const ts = Date.now()` ngay từ đầu.
3. Grab full frame như cũ (`grabFullFrame` — độ trễ `takePhoto` không tránh được nhưng giờ vô hình) → `limitSize` → `cropAspect` → **mirror TẠI ĐÂY** (chuyển bước mirror từ sau enhance lên trước quick-save; nó chỉ là drawImage). Kết quả: `canvas` hình học cuối cùng.
4. **Quick-save**: `canvas.toBlob(jpegQuality)` → `saveMedia({ id, ts, blob, thumbBlob: quickThumb, type:"photo", mode, pending: needsWorker })`. Giữ `savePromise`. Cập nhật thumb từ item đã lưu. **`store.busy = false` TẠI ĐÂY** — nút chụp mở lại (~200-500ms sau chạm, chỉ còn phụ thuộc takePhoto).
5. Tính `needsWorker`: true nếu (`settings.autoEnhance && pipeline !== "pro"`) hoặc pipeline thuộc `portrait|food|landscape|night`. Nếu false ⇒ xong, gọi `maybeAutoDownload(blob, ts)` luôn.
6. Nếu portrait: chạy `initSegmenter()` + `seg.segment(canvas)` trên main (segmenter vẫn ở main thread trong Phase A), lấy `maskArr` và **transfer `maskArr.buffer`**.
7. `const bitmap = await createImageBitmap(canvas)` → `pipeline.enhanceInWorker({id, kind:"photo", bitmap, mode, mask, ...})` (bitmap trong transfer list).
8. Khi worker trả kết quả: `await savePromise`, rồi `updateMedia(id, { blob, thumbBlob, pending: false })` (hàm mới trong gallery.js), refresh `galleryThumb` nếu id này vẫn là mới nhất, `setThumbProcessing(false)`, `maybeAutoDownload(finalBlob, ts)`. Worker lỗi: `updateMedia(id, {pending:false})`, toast `"Không xử lý được ảnh — đã lưu bản gốc"`, download bản quick.
9. Night mode: thay `grabVideoFrames` canvas bằng `createImageBitmap(video)` mỗi frame (6 frame, giữ gap 90ms trong Phase A), quick-save frame #0 (đã crop) ngay, gửi `{kind:"night", bitmaps}` cho worker.
10. **Đường fallback** (không có worker): giữ nguyên luồng đồng bộ hôm nay thành `capturePhotoSync()` (guard bằng `pipeline.isWorkerAvailable()`), gọi wrapper trong enhance.js.

Concurrency: `store.busy` chỉ giữ từ lúc chạm đến quick-save (chặn chụp đúp cùng frame); job worker của các lần chụp liên tiếp tự xếp hàng. `setThumbProcessing(false)` chỉ khi không còn job pending (đếm pending trong pipeline.js).

### A4. Sửa gallery (`js/gallery.js`)
- `saveMedia` (gallery.js:60): nhận thêm optional `id`, `ts`, `thumbBlob`, `pending`. Chỉ gọi `makeThumb` khi KHÔNG được cấp `thumbBlob` (đường video vẫn dùng). Loại bỏ hoàn toàn việc decode lại blob (gallery.js:35) khỏi critical path chụp ảnh.
- Thêm `export async function updateMedia(id, patch)`: `getOne` → `{...item, ...patch}` → `put` trong 1 transaction readwrite. Resolve item đã cập nhật.
- Dọn rò rỉ: `updateThumb` (capture.js:205) và `updateThumbFromItem` (ui.js:438) phải `URL.revokeObjectURL` URL cũ (lưu URL cuối trong biến module).

### A5. Tự động tải về Downloads — file mới `js/download.js`
```js
export function photoFilename(ts)            // → "IMG_20260717_143025.jpg" (giờ địa phương, pad 0)
export function downloadBlob(blob, filename) // objectURL → <a download> .click() → revoke sau 10s
export function maybeAutoDownload(blob, ts)  // gate theo store.settings.autoDownload
```
- Thêm `autoDownload: true` vào `DEFAULT_SETTINGS` (state.js:8).
- Thêm hàng settings trong index.html (sau hàng "AI tự đẹp ảnh", index.html:160): nhãn `"Tự lưu vào máy"`, mô tả `"Ảnh JPEG tự tải về thư mục Tải xuống (hiện trong Thư viện ảnh)"`, checkbox id `setDownload`. Thêm `"setDownload"` vào danh sách id trong `collectDom` (ui.js:19-30), bind trong `bindSettings` (ui.js:321): `bind(el.setDownload, "autoDownload")`, init checked.
- **Lưu ý Chrome**: download lập trình lần đầu OK; lần 2 Chrome hỏi quyền "Tự động tải xuống nhiều tệp" MỘT lần — cho phép rồi thì im lặng mãi. `showSaveFilePicker` KHÔNG có trên Android Chrome ⇒ anchor là đúng. Rủi ro: download cuối bắn từ callback worker (không phải user gesture) có thể bị chặn ở một số trình duyệt ⇒ giữ nút "Tải về" thủ công trong viewer (ui.js:489) làm lối thoát. KHÔNG dùng Native File System API.
- Toast hướng dẫn 1 lần đầu: `"Cho phép 'Tự động tải xuống' khi Chrome hỏi để lưu ảnh vào máy"` (cờ `_downloadHintShown` trong settings).

### A6. Cập nhật sw.js
- `CACHE` → `"camera-ai-v3"` (sw.js:7).
- Thêm vào `PRECACHE_URLS` (sw.js:15): `"./js/enhance-core.js"`, `"./js/pipeline.js"`, `"./js/download.js"`, `"./js/worker/enhance-worker.js"`.

### A7. Checklist kiểm thử Phase A
Desktop Chrome (`python3 -m http.server` + webcam thật):
- [ ] Chạm chụp: thumbnail đổi trong <100ms (Performance panel: không task main-thread >150ms sau chạm ngoài await takePhoto).
- [ ] Chạm chụp lại được ngay; 2 phát liên tiếp ra 2 record.
- [ ] IndexedDB (Application → camera-gallery): record hiện `pending:true`, sau ~1-2s blob/thumb đổi và `pending:false`.
- [ ] JPEG rơi vào Downloads tên `IMG_yyyyMMdd_HHmmss.jpg`; tắt "Tự lưu vào máy" ⇒ không download.
- [ ] Ảnh enhance ra giống hệt bản trước refactor cho photo/food/landscape/portrait/night (so side-by-side với build cũ).
- [ ] Fallback: override `window.OffscreenCanvas = undefined` sớm ⇒ đường sync vẫn chụp được.
- [ ] Offline: load 1 lần, DevTools offline, reload ⇒ app + chụp + worker chạy (worker file từ SW cache).

Android Chrome (host HTTPS — GitHub Pages hoặc `adb reverse`):
- [ ] Chụp cảm giác tức thì; ảnh hiện trong Files→Downloads và Google Photos/Thư viện sau media scan.
- [ ] Prompt "nhiều tệp" hiện 1 lần ở ảnh thứ 2.
- [ ] Bokeh chân dung nhanh hơn rõ rệt (A2); night mode UI không đơ khi xử lý.

---

## 4. PHASE B — AI mượt & chính xác hơn

### B1. File mới `js/ai-smooth.js` — temporal smoothing & hysteresis
```js
export class SubjectTracker {
  update(detections, tsMs) → { box, label, stable } | null
}
export class GuidanceStabilizer {
  update(rawState /* "left"|"right"|"up"|"down"|"good"|"none" */) → displayedState
}
```
- **SubjectTracker**: chọn detection tốt nhất theo điểm hiện có (diện tích × priority, composition.js:64-70); match với chủ thể trước bằng **IoU > 0.3** (chặn nhảy chủ thể mỗi frame); làm mượt box bằng **EMA** (`s = s*(1-α) + raw*α`, α≈0.35; không match IoU >600ms ⇒ reset). `stable` = tâm di chuyển trong 10 update gần nhất < 2% khung hình.
- **GuidanceStabilizer**: hướng raw tính mỗi lần detect; hướng HIỂN THỊ chỉ đổi sau **3 raw state giống nhau liên tiếp**; "good" dùng ngưỡng kép — vào khi lệch ≤8% (snapX/snapY hiện có, composition.js:90-91), **ra chỉ khi >11%** (hysteresis diệt nhấp nháy ở biên).

### B2. Nối vào composition.js + main.js
- `handleComposition` (composition.js:60): đổi signature nhận `{box,label}` đã smooth từ SubjectTracker thay vì detections raw; tính hướng raw rồi qua GuidanceStabilizer trước khi `updateGuide`; khi good và `stable` hiện `"✔ Bố cục đẹp — giữ chắc tay!"`; vẽ box mỗi rAF frame từ state tracker (box lướt mượt thay vì giật).
- `renderLoop` (main.js:37): thêm **throttle detect** — ngoài gate `currentTime` (main.js:49), yêu cầu `performance.now() - store.lastDetectMs >= 80` (~12Hz) trước khi gọi `detectObjects`/`detectFaces`. Overlay (grid, box smooth, faces) vẫn vẽ mỗi frame từ state cache. Thêm `lastDetectMs` vào store (khu state.js:66). Riêng cái này đã giải phóng đáng kể main thread cho Phase A.
- `drawFaces`: smooth box mặt bằng instance SubjectTracker thứ hai (đơn giản: track top-1 face).
- `sceneSuggest` (main.js:131): yêu cầu **3 mẫu liên tiếp** luma<50 mới gợi ý Night (đếm counter), giữ cooldown 12s.

### B3. Nâng cấp model/version
- Bump MediaPipe `0.10.14 → 0.10.22`: đổi `MP_VER` (state.js:79) **VÀ** `MP` (sw.js:10) **VÀ** bump `CACHE` → `"camera-ai-v4"`. Tên file wasm giữ nguyên (`vision_wasm_internal.*`, `vision_wasm_nosimd_internal.*`) nên precache chỉ đổi chuỗi version. API 0.10.x ổn định (`createFromOptions`/`detectForVideo` không đổi); nếu test thấy hỏng ⇒ revert về 0.10.14 — bước bump này **độc lập, có thể bỏ**.
- **Object detector**: đổi `MODELS.object` (state.js:82) sang EfficientDet-**Lite2** float16: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite` (~7MB vs ~4.5MB; chính xác hơn rõ với chủ thể nhỏ; chịu được ở 12Hz + GPU delegate). Hạ `scoreThreshold` 0.5 → 0.4 (ai.js:36) — tracker IoU + EMA giờ hấp thụ được detection nhiễu. Cập nhật URL precache (sw.js:51). Nếu Android yếu tụt hiệu năng (>90ms/inference) ⇒ giữ Lite0 — chỉ là 1 hằng số.
- **Chất lượng xoá phông (thắng lợi nhìn thấy rõ nhất, rẻ)**: trong `initSegmenter` (ai.js:67) đổi `outputConfidenceMasks: true, outputCategoryMask: false`; trong `applyPortrait` (capture.js:146) dùng `res.confidenceMasks[0].getAsFloat32Array()` làm **alpha mềm** (xác suất người 0..1 → Uint8 0..255) thay mask nhị phân. Truyền vào `portraitBokehData`, thay bước binarize+feather của `buildPersonAlpha` bằng upscale bilinear mask mềm + feather `blurAlpha` với radius bằng NỬA hiện tại. Model file không đổi (selfie_segmenter). Stretch (chỉ khi tóc vẫn xấu): `selfie_multiclass_256x256` (alpha = hair+skin+body+clothes) nhưng +16MB — mặc định: BỎ QUA.
- **KHÔNG** chuyển MediaPipe vào worker phase này — với throttle 12Hz + GPU delegate, chi phí main-thread chấp nhận được; chuyển vào worker đòi stream ImageBitmap mỗi frame + nhân đôi cache wasm. Ghi chú là future work.

### B4. Checklist kiểm thử Phase B
- [ ] Desktop: chĩa vào vật tĩnh — chữ hướng dẫn KHÔNG đổi trong ≥5s; box không giật thấy được; lia máy chậm qua ngưỡng good — chữ đổi tối đa 1 lần (hysteresis).
- [ ] DevTools Performance: `detectForVideo` ≤ ~12 lần/s; frame renderLoop <8ms giữa các lần detect.
- [ ] Chụp chân dung: mép tóc/vai chuyển bokeh mượt dần, không viền halo cứng.
- [ ] Offline sau bump cache: clear site data, load online 1 lần, offline, reload — AI vẫn khởi tạo (model mới + MP mới đều precache). Cache cũ `camera-ai-v3` bị xóa (Application → Cache Storage).
- [ ] Android: hướng dẫn bố cục đọc được và ổn định khi vừa đi vừa quay; preview không giật ở mode photo.

---

## 5. PHASE C — Night mode v2 kiểu PhotonCamera/HDR+, HDR bracketing, Pro polish

### C1. File mới `js/worker/night.js` (enhance-worker.js import)
Thuật toán vừa sức điện thoại (frame ~1080-2160p, chạy hết trong worker):

1. **Burst capture (main thread, capture.js)**: tăng lên **8 frame**. Dùng `video.requestVideoFrameCallback` khi có để lấy 8 frame **khác nhau** thành ImageBitmap (fallback: gap `setTimeout` 60ms). Giữ hint `"Giữ chắc tay 📷"` (capture.js:104). Tuỳ chọn: nếu `hasRange(caps.exposureCompensation)` (camera.js:141) ⇒ áp +max/2 EV trước burst, restore sau (try/finally).
2. **Pyramid xám** mỗi frame trong worker: luma Float32Array downscale còn ≤256px rộng (area-average), thêm 2 mức half-res (pyramid 3 tầng).
3. **Chọn frame tham chiếu**: frame nét nhất = variance của Laplacian 3×3 lớn nhất trên tầng nhỏ nhất (loại frame nhòe nhất khỏi vai trò tham chiếu).
4. **Căn chỉnh toàn cục chỉ-tịnh-tiến** (rung tay ở thang thời gian burst xấp xỉ tịnh tiến tốt): mỗi frame không-tham-chiếu, block matching coarse-to-fine — tầng nhỏ nhất tìm SAD toàn diện ±4px; nhân shift ×2 khi xuống tầng, tinh chỉnh ±1px. Chi phí không đáng kể (<50ms cho 8 frame). Frame có SAD cuối > 1.5× median SAD các frame ⇒ **LOẠI** (chuyển động/che khuất nặng).
5. **Merge bền vững** ở full-res, mỗi pixel mỗi kênh: giá trị tham chiếu `r`, ứng viên `v` từ mỗi frame đã căn (sample dịch nguyên; bỏ out-of-bounds); trọng số `w = 1 / (1 + (d/σ)²)` với `d = |v - r|`, `σ = max(8, noiseScale·sqrt(r))` (mô hình nhiễu kiểu Poisson, `noiseScale≈1.2`); output `(r + Σ w·v) / (1 + Σ w)`. Đây là soft outlier rejection kiểu Wiener: vùng tĩnh trung bình ~8 frame (~3 stop bớt nhiễu), chủ thể chuyển động rơi về frame tham chiếu nét — **không ghost**. Cài đặt: input Uint8ClampedArray, accumulator Float32, 1 vòng lặp; ước tính 0.5-1.5s trong worker cho 8×1080p — chấp nhận được, UI vẫn sống.
6. **Hậu kỳ**: khử nhiễu chroma (chuyển YCbCr tại chỗ, `boxBlur` radius 2 CHỈ trên Cb/Cr, chuyển lại RGB) → `gamma(0.72)` → `autoLevels` có **bảo vệ highlight** (không kéo `hi` xuống dưới 240 để đèn không cháy) → `unsharpMaskData(0.35, 1)`. Toàn hàm core sẵn có.

Nối: handler `kind:"night"` của enhance-worker gọi `alignAndMerge(bitmaps)` từ night.js thay `stackFramesData`. Giữ `stackFramesData` làm fallback nếu alignment throw.

### C2. HDR bracketing (mode photo, toggle tuỳ chọn)
- Setting mới `hdrMode: false`, hàng settings `"HDR (dải sáng rộng)"` mô tả `"Chụp 3 ảnh chênh sáng rồi ghép"`, id `setHdr`; chỉ enable khi `hasRange(store.caps.exposureCompensation)` (check trong `bindSettings`, không thì làm mờ).
- capture.js: khi `hdrMode` + mode photo: chụp 3 frame từ video stream ở EV −1, 0, +1 (áp `exposureCompensation` qua `applyConstraints`, chờ ~150ms/2 frame settle giữa các lần, restore EV trong finally; tái dùng `applyEV`, camera.js:181). Quick-save frame EV0 ngay (luồng Phase A không đổi), gửi `{kind:"hdr", bitmaps:[...]}`.
- Worker (`night.js`, dùng chung code alignment): căn về tham chiếu EV0, rồi **exposure fusion kiểu Mertens**: trọng số mỗi pixel = well-exposedness `exp(−(l−0.5)²/0.08)` × contrast cục bộ (|Laplacian| trên luma, có blur); chuẩn hoá; blend. Bỏ multi-band pyramid (chất lượng đủ với blur nhẹ trên weight map — radius ~8 qua `blurAlpha`). EV constraint không hỗ trợ ⇒ ẩn toggle; không cần fallback cùng-exposure (night mode đã lo merge nhiễu).

### C3. Pro controls polish (`buildProPanel`, ui.js:189)
- Slider `exposureTime` map **logarit** (`value = min·(max/min)^t`), hiển thị dạng `1/x s`.
- Chip `AUTO` reset mỗi control: áp lại `{exposureMode|whiteBalanceMode|focusMode: "continuous"}` và trả slider về.
- Chip bật torch trong pro panel khi `caps.torch`.
- KHÔNG thêm API phần cứng mới ngoài những gì `getCapabilities` đã expose (iso/exposureTime/colorTemperature/focusDistance/exposureCompensation đã xử lý sẵn).

### C4. Đường WebGL2 — **khuyến nghị: HOÃN, không làm**
Sau A2 (blur O(n)) + worker offload, chi phí CPU còn lại (~0.5-1.5s trong worker cho night merge, ~300ms cho enhance thường) người dùng không cảm nhận được. WebGL2 thêm shader, xử lý context-loss, và pipeline thứ 2 phải giữ parity — đổi lấy độ trễ đã vô hình. Chỉ xem lại nếu profiling Phase C trên Android yếu cho thấy job worker >4s. Ghi rationale này vào comment trong enhance-worker.js.

### C5. sw.js
`CACHE` → `"camera-ai-v5"`; thêm `"./js/worker/night.js"` vào `PRECACHE_URLS`.

### C6. Checklist kiểm thử Phase C
- [ ] Desktop (webcam, phòng tối): chụp night cố tình rung tay — so v1 (giấu lời gọi `stackFramesData` sau query flag `?night=v1` để A/B) vs v2: v2 không viền đôi trên cạnh tương phản cao; nhiễu thấp hơn rõ so với 1 frame đơn.
- [ ] Test người đi ngang cảnh đêm ⇒ không vệt ghost (trọng số loại bỏ).
- [ ] Log thời gian worker (`console.time`): merge <2s @1080p desktop, <4s Android tầm trung.
- [ ] HDR: cảnh cửa sổ + nội thất tối → bật: cửa sổ không cháy, nội thất được nâng; EV restore sau chụp (preview sáng trở lại bình thường).
- [ ] Pro: slider shutter hiện dạng 1/30; chip AUTO trả về continuous.
- [ ] Offline reload OK sau bump cache; cache cũ bị xoá.

---

## 6. Yêu cầu xuyên suốt & quản trị rủi ro

- **Ràng buộc version**: mọi thay đổi MediaPipe đụng CẢ state.js:79-85 VÀ sw.js:10/51-57; mọi file JS mới phải vào `PRECACHE_URLS` + bump `CACHE`, không thì offline hỏng âm thầm.
- **Không build step**: file mới là ES module thuần; worker tạo bằng `new URL(..., import.meta.url)`; đường dẫn `./` an toàn GitHub Pages subpath.
- **Chuỗi tiếng Việt** cho mọi UI mới: hàng settings, toast (`"Đã lưu ảnh"`, `"Đang xử lý nền…"`, `"Không xử lý được ảnh — đã lưu bản gốc"`, nhãn HDR).
- **Bảng rủi ro & fallback**:
  | Rủi ro | Fallback |
  |---|---|
  | Không có OffscreenCanvas/module worker | `capturePhotoSync` đường cũ (giữ nguyên, có test) |
  | Worker lỗi giữa chừng | Bản quick-save còn nguyên, record đánh dấu xong |
  | Auto-download bị chặn (ngoài user gesture) | Nút "Tải về" thủ công trong viewer vẫn còn |
  | MP 0.10.22 trục trặc | Bước bump độc lập, revert được riêng |
  | Lite2 chậm trên máy yếu | Revert 1 hằng số về Lite0 |
  | Alignment night throw | Fallback `stackFramesData` cộng trung bình |
- **Commit**: 1 commit cho mỗi bước chữ-số (A1…C5), phase ship độc lập được.

## 7. Danh sách file thay đổi

| File | Loại | Phase |
|---|---|---|
| `js/enhance-core.js` | MỚI — lõi pixel thuần, không DOM/import | A |
| `js/worker/enhance-worker.js` | MỚI — pipeline off-main-thread | A |
| `js/pipeline.js` | MỚI — façade worker + feature detect | A |
| `js/download.js` | MỚI — auto-download Downloads | A |
| `js/worker/night.js` | MỚI — align + merge + HDR fusion | C |
| `js/ai-smooth.js` | MỚI — SubjectTracker + GuidanceStabilizer | B |
| `js/capture.js` | SỬA — tái cấu trúc capturePhoto, burst, dispatch worker | A, C |
| `js/enhance.js` | SỬA — tách lõi, giữ wrapper DOM/fallback | A |
| `js/gallery.js` | SỬA — saveMedia mở rộng, updateMedia mới | A |
| `js/composition.js` | SỬA — nhận box smooth, hysteresis | B |
| `js/main.js` | SỬA — throttle detect 12Hz | B |
| `js/ai.js` | SỬA — confidence mask, model Lite2 | B |
| `js/state.js` | SỬA — settings mới, MP_VER, model URL | A, B, C |
| `js/ui.js` | SỬA — settings row mới, pro panel polish, revoke URL | A, C |
| `index.html` | SỬA — hàng settings mới | A, C |
| `sw.js` | SỬA — precache file mới, bump cache v3→v4→v5 | A, B, C |
