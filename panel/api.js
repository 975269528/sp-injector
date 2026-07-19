// api.js · API 封装 + 全局工具 · 最先加载，供后续 views 使用
window.spApp = window.spApp || {};

// 全局工具（必须在 views 加载前可用）
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
spApp.$ = $;
spApp.esc = esc;

spApp.api = {
  async get(path) {
    const r = await fetch(path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    return r.json();
  },
};
