/* =========================================================
 * modes.js — Định nghĩa các chế độ chụp
 * Mỗi mode: { id, label, ai, previewFilter, capture, ui }
 * ========================================================= */
import { PREVIEW_FILTERS } from "./enhance.js";

export const MODES = [
  { id: "night",     label: "Đêm",       ai: "object",  filter: PREVIEW_FILTERS.night,     pipeline: "night" },
  { id: "portrait",  label: "Chân dung", ai: "face",    filter: PREVIEW_FILTERS.portrait,  pipeline: "portrait", ui: ["blurSlider"] },
  { id: "photo",     label: "Ảnh",       ai: "object",  filter: PREVIEW_FILTERS.photo,     pipeline: "photo" },
  { id: "landscape", label: "Phong cảnh",ai: "object",  filter: PREVIEW_FILTERS.landscape, pipeline: "landscape", ui: ["horizon"] },
  { id: "food",      label: "Món ăn",    ai: "none",    filter: PREVIEW_FILTERS.food,      pipeline: "food" },
  { id: "pro",       label: "Pro",       ai: "none",    filter: PREVIEW_FILTERS.pro,       pipeline: "pro", ui: ["proPanel", "histogram"] },
  { id: "video",     label: "Video",     ai: "none",    filter: PREVIEW_FILTERS.video,     pipeline: "video" },
];

export const DEFAULT_MODE = "photo";

export function getMode(id) {
  return MODES.find(m => m.id === id) || MODES.find(m => m.id === DEFAULT_MODE);
}
