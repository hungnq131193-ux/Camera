# 📷 Camera AI (PWA · 100% Offline)

Ứng dụng **Camera PWA chuyên nghiệp** chạy trên Chrome/Android: đa chế độ chụp
(Chân dung, Đêm, Phong cảnh, Món ăn, Pro, Video), **AI client-side (MediaPipe)**
hướng dẫn bố cục 1/3 + xử lý ảnh sau chụp, khai thác tối đa phần cứng camera.
Sau lần mở đầu tiên có mạng, app + AI chạy **hoàn toàn offline** (không backend,
không API bên thứ ba). Không build step — **ES modules thuần**.

## ✨ Tính năng

### Phần cứng camera (khai thác tối đa `getCapabilities()`)
- **Đa ống kính**: nhận diện ống kính sau (ultra-wide/wide/tele) → nút `0.5x | 1x | 2x`
  (chỉ hiện ống kính có thật). Không có nhiều lens → zoom số.
- **Tap-to-focus**: chạm preview → lấy nét điểm (`pointsOfInterest`) + focus ring,
  kèm **thanh EV** (☀️ trượt dọc) chỉnh phơi sáng; tự về continuous sau 3s.
- **Pinch-to-zoom** 2 ngón + slider zoom, hiển thị `1.0x…`.
- **Torch / Flash**: bật/tắt đèn; flash "on" ở mode thường → chớp torch quanh lúc chụp.
- **Hẹn giờ** 0/3/10s (đếm ngược to giữa màn hình + beep).
- **Tỉ lệ khung** 4:3 / 16:9 / 1:1 (mask đen preview + crop khi chụp).
- Đọc đầy đủ: zoom, focusMode, exposureCompensation, exposureTime, iso,
  colorTemperature, torch, pointsOfInterest… — **mọi control feature-detect**, thiếu thì ẩn.

### Chế độ chụp
| Chế độ | Hành vi |
|--------|---------|
| **Ảnh** | AI bố cục 1/3 (EfficientDet) + auto-enhance khi chụp |
| **Chân dung** | FaceDetector realtime; khi chụp: ImageSegmenter tách người → **xoá phông bokeh** (feather biên) + làm mịn da. Slider mức xoá phông 0–25 |
| **Đêm** | Chụp **6 frame → cộng trung bình (stacking)** giảm nhiễu + nâng sáng gamma + unsharp. Nhắc "Giữ chắc tay" |
| **Phong cảnh** | Bố cục 1/3 + **cân bằng đường chân trời** (DeviceOrientation); chụp: tăng saturation/contrast |
| **Món ăn** | Tone ấm + vibrance + vignette (preview CSS filter, chụp khớp bằng canvas) |
| **Pro** | Panel chỉnh tay ISO / Shutter / WB / Focus / EV (chỉ hiện nếu caps hỗ trợ) + **histogram realtime** |
| **Video** | MediaRecorder (mp4/h264 → webm/vp9), bitrate 8Mbps, nút đỏ + đồng hồ, lưu gallery |

### AI (MediaPipe Tasks Vision, lazy-init theo mode, GPU→CPU fallback)
- **ObjectDetector** EfficientDet-Lite0 — bố cục 1/3.
- **FaceDetector** BlazeFace short-range — mode Chân dung.
- **ImageSegmenter** SelfieSegmenter — xoá phông (chỉ chạy lúc chụp).
- **Auto-enhance** (thuần ImageData): auto-levels (cắt 0.5%), white balance gray-world,
  vibrance (giữ da), unsharp mask.
- **Gợi ý cảnh**: sample 64×64 đo độ sáng → toast "Chuyển Đêm?" / "Chuyển Chân dung?".
- **Tự động chụp**: bố cục đẹp ổn định ~1.5s → tự chụp (tắt mặc định).

### Thư viện & PWA
- **Gallery IndexedDB** (`camera-gallery`): grid ảnh/video, viewer, **Chia sẻ**
  (`navigator.share`), **Tải về**, **Xoá**; `storage.estimate()` cảnh báo đầy,
  `storage.persist()` lưu bền.
- **Service Worker** precache app shell + Tailwind + MediaPipe (JS/WASM) + 3 model;
  cache-first + runtime caching.
- **Cài như app**: `manifest.json` + shortcuts (Chụp ngay / Thư viện).

## 📁 Cấu trúc

| File | Vai trò |
|------|---------|
| `index.html` | Khung HUD + icon SVG, nạp `js/main.js` |
| `css/app.css` | Toàn bộ style (preview, HUD, sheet, gallery, animation) |
| `js/main.js` | Điểm vào: wiring + vòng lặp render |
| `js/state.js` | Store dùng chung + settings + URL model |
| `js/camera.js` | Phần cứng: startCamera, lens, capabilities, zoom, tap-focus, EV, torch, aspect |
| `js/ai.js` | MediaPipe: Object/Face detector, Segmenter, sample sáng/histogram |
| `js/composition.js` | Thuật toán bố cục 1/3 (giữ nguyên từ bản gốc) |
| `js/enhance.js` | Xử lý ảnh: auto-levels, WB, vibrance, unsharp, bokeh, stacking, filter |
| `js/modes.js` | Định nghĩa các chế độ chụp |
| `js/capture.js` | Pipeline chụp ảnh + quay video |
| `js/gallery.js` | Thư viện IndexedDB |
| `js/ui.js` | Wiring UI: top bar, carousel, settings, gallery, pro panel |
| `manifest.json` | Cấu hình PWA + shortcuts |
| `sw.js` | Service Worker cache offline |
| `icon.svg` | Icon máy ảnh (maskable) |

## 🚀 Chạy thử local

> `getUserMedia` và Service Worker **bắt buộc HTTPS** hoặc `localhost`.

```bash
python3 -m http.server 8000
# Mở Chrome: http://localhost:8000
```

## ☁️ Deploy GitHub Pages

1. Push code lên GitHub.
2. **Settings → Pages**: *Deploy from a branch*, thư mục `/ (root)`.
3. Mở `https://<user>.github.io/<repo>/` bằng Chrome trên Android.

Mọi đường dẫn trong app đều **tương đối** (`./`) nên chạy đúng trên subpath repo.

## ▲ Deploy Vercel (link ngay từ GitHub)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/hungnq131193-ux/camera)

**Cách 1 — bấm nút trên (nhanh nhất):** đăng nhập Vercel → clone repo → nhận
link `https://<project>.vercel.app` chạy HTTPS (camera + Service Worker OK).

**Cách 2 — kết nối repo GitHub:**
1. Vào [vercel.com/new](https://vercel.com/new) → **Import** repo `hungnq131193-ux/camera`.
2. Framework Preset để **Other** (app tĩnh, không build). Bỏ trống Build Command
   & Output Directory.
3. **Deploy** → mỗi lần `git push` Vercel tự build lại (Preview cho nhánh, Production cho `main`).

File [`vercel.json`](./vercel.json) đã cấu hình sẵn: header `Service-Worker-Allowed: /`
cho `sw.js`, đúng `Content-Type` cho `manifest.json`, và `Permissions-Policy` mở
quyền camera/mic — nên PWA + offline hoạt động luôn không cần chỉnh thêm.

## 📴 Test offline

1. Mở link **1 lần khi có mạng** → chờ badge AI **"AI sẵn sàng"** (đã cache model).
2. Bật **chế độ máy bay**.
3. Mở lại app: camera + AI + gallery **vẫn chạy**.

## ✅ Checklist test tay trên điện thoại thật

Camera giả (Chromium) **không kiểm được** phần cứng — hãy test tay:

- [ ] **Đa ống kính**: nút `0.5x/1x/2x` hiện & đổi ống kính đúng (máy nhiều camera sau).
- [ ] **Tap-to-focus**: chạm → focus ring + ảnh nét lại; thanh EV kéo đổi sáng.
- [ ] **Pinch-to-zoom** 2 ngón mượt, khớp slider.
- [ ] **Torch/Flash**: bật đèn; flash "on" chớp quanh lúc chụp.
- [ ] **Đêm**: giữ máy → 6 frame stacking, ảnh sáng & bớt nhiễu hơn 1 frame.
- [ ] **Chân dung**: xoá phông bokeh mượt, biên người không rỗ, da mịn nhẹ.
- [ ] **Phong cảnh**: vạch chân trời đổi xanh khi máy thẳng.
- [ ] **Pro**: các thanh ISO/Shutter/WB/Focus hiện đúng theo máy, đổi có tác dụng.
- [ ] **Video**: quay + lưu, phát lại trong gallery.
- [ ] **Chia sẻ**: `navigator.share` mở sheet hệ thống với file ảnh.

## ⚠️ Ghi chú kỹ thuật

- `exposureTime`/`iso`/`focusDistance` rất ít máy Android hỗ trợ qua web → **feature-detect**,
  ẩn khi thiếu; mode Đêm **không phụ thuộc** chúng (stacking là chính).
- `ImageCapture` là API riêng Chrome → fallback vẽ canvas cho thiết bị khác.
- Segmentation/enhance chạy async sau khi hiện thumbnail tạm (spinner), không block UI;
  ảnh >16MP downscale cạnh dài về 4096px trước khi xử lý.
- Camera trước bị lật gương → toạ độ tap-focus & bbox lật X cho khớp hiển thị.

## 🔒 Quyền riêng tư

Ảnh, video và toàn bộ xử lý AI diễn ra **trên máy người dùng**. Không có dữ liệu
nào được gửi đi đâu cả.
