# 📷 Camera AI Bố cục (PWA · 100% Offline)

Ứng dụng **Camera PWA** chạy trên Chrome/Android, chụp ảnh độ phân giải cao khai
thác phần cứng và dùng **AI client-side (MediaPipe Object Detection)** để hướng
dẫn bố cục theo **quy tắc 1/3** theo thời gian thực. Sau lần mở đầu tiên có mạng,
app + AI chạy **hoàn toàn offline** (không backend, không API bên thứ ba).

## ✨ Tính năng

- **Chụp ảnh chất lượng cao**: WebRTC `getUserMedia` (ưu tiên camera sau, độ phân
  giải tới 4K) + `ImageCapture.takePhoto()`; tự fallback vẽ frame lên canvas ở độ
  phân giải native nếu thiết bị không hỗ trợ.
- **Zoom & lấy nét liên tục**: đọc `getCapabilities()`, hiện thanh zoom khi phần
  cứng hỗ trợ, bật `focusMode: continuous`.
- **AI bố cục thời gian thực**: MediaPipe Tasks Vision (EfficientDet-Lite0,
  float16, GPU→CPU fallback) phát hiện chủ thể; thuật toán thuần toán học so tâm
  chủ thể với 4 giao điểm lưới 1/3 và ra chỉ dẫn (⬅️➡️⬆️⬇️ / ✔ Bố cục đẹp).
- **PWA offline**: Service Worker precache app shell + Tailwind + MediaPipe
  (JS/WASM) + model; chiến lược **cache-first** kèm runtime caching.
- **Cài như app**: `manifest.json` chuẩn, màn hình dọc, cài về màn hình chính.

## 📁 Cấu trúc

| File | Vai trò |
|------|---------|
| `index.html` | UI + toàn bộ logic (camera, MediaPipe, thuật toán 1/3) |
| `manifest.json` | Cấu hình PWA (standalone, portrait) |
| `icon.svg` | Icon máy ảnh (maskable) |
| `sw.js` | Service Worker cache offline |

## 🚀 Chạy thử local

> `getUserMedia` và Service Worker **bắt buộc HTTPS** hoặc `localhost`.

```bash
# Trong thư mục dự án
python -m http.server 8000
# Mở Chrome: http://localhost:8000
```

Trên `localhost`, trình duyệt coi là "secure context" nên camera + SW hoạt động.

## ☁️ Deploy GitHub Pages

1. Push code lên GitHub.
2. **Settings → Pages → Build and deployment**: chọn *Deploy from a branch*,
   branch chứa code, thư mục `/ (root)`.
3. Mở link `https://<user>.github.io/<repo>/` bằng Chrome trên Android.

GitHub Pages phục vụ qua HTTPS nên đủ điều kiện cho camera + PWA. Mọi đường dẫn
trong app đều **tương đối** (`./`) nên chạy đúng trên subpath repo.

## 📴 Test offline (điện thoại thật)

1. Mở link GitHub Pages **1 lần khi có mạng** → chờ badge AI chuyển **"AI sẵn
   sàng"** (đã tải & cache xong model).
2. Bật **chế độ máy bay** (hoặc tắt Wi-Fi/4G).
3. Mở lại app: camera + hướng dẫn bố cục AI **vẫn chạy** (badge hiển thị ✈️ Offline).

## ⚠️ Ghi chú kỹ thuật

- `ImageCapture` là API riêng của Chrome → đúng target; thiết bị khác dùng
  fallback canvas.
- Trên desktop/thiết bị không có camera sau, app tự fallback
  `environment` → `user` để không bị treo.
- Canvas overlay tự resize theo `window.resize` / `orientationchange`, xử lý
  `object-fit: cover` để toạ độ bounding box khớp hiển thị.

## 🔒 Quyền riêng tư

Ảnh và toàn bộ xử lý AI diễn ra **trên máy người dùng**. Không có dữ liệu nào
được gửi đi đâu cả.
