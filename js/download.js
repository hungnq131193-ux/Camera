/* =========================================================
 * download.js — Tự động tải ảnh JPEG về thư mục Tải xuống
 * Android Chrome không có showSaveFilePicker → dùng <a download>.
 * Ảnh trong Downloads sẽ hiện ở app Thư viện / Google Photos sau media scan.
 * ========================================================= */
import { store, saveSettings } from "./state.js";

function pad(n) { return String(n).padStart(2, "0"); }

// "IMG_20260717_143025.jpg" theo giờ địa phương
export function photoFilename(ts) {
  const d = new Date(ts);
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

export function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 10000);
  } catch (err) {
    console.warn("Tải ảnh về máy lỗi:", err);
  }
}

export function maybeAutoDownload(blob, ts) {
  if (!store.settings.autoDownload || !blob) return;
  // Nhắc 1 lần đầu: Chrome sẽ hỏi quyền "Tự động tải xuống nhiều tệp"
  if (!store.settings._downloadHintShown && store.el && store.el.toast) {
    store.el.toast("Cho phép 'Tự động tải xuống' khi Chrome hỏi để lưu ảnh vào máy", 4000);
    store.settings._downloadHintShown = true;
    saveSettings();
  }
  downloadBlob(blob, photoFilename(ts));
}
