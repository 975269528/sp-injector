// lib/logger.js · 环形缓冲日志 · 知止可以不殆
// 只记 system 长度+预览，不记 user message 内容（隐私）

const MAX = 200;
let _buf = [];
let _seq = 0;
let _stats = {
  totalRequests: 0,
  injected: 0,
  passthrough: 0,
  errors: 0,
  startedAt: Date.now(),
};

function push(entry) {
  _seq++;
  _stats.totalRequests++;
  if (entry.injected) _stats.injected++;
  else _stats.passthrough++;
  if (entry.error) _stats.errors++;
  _buf.push({ seq: _seq, ts: Date.now(), ...entry });
  if (_buf.length > MAX) _buf.shift();
}

function list() {
  return [..._buf].reverse(); // 最新在前
}

function clear() {
  _buf = [];
}

function stats() {
  return { ..._stats, buffered: _buf.length };
}

// 把 system（字符串或数组格式）标准化成纯文本+长度，取前 N 字预览
function previewSystem(system, n = 200) {
  let text = "";
  if (typeof system === "string") text = system;
  else if (Array.isArray(system))
    text = system
      .map((b) => (b && typeof b === "object" ? b.text || "" : String(b)))
      .join("\n");
  else if (system) text = String(system);
  return {
    len: text.length,
    sample: text.slice(0, n),
  };
}

module.exports = { push, list, clear, stats, previewSystem };
