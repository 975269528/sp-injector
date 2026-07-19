// lib/capture.js · System 抓取 · 知止可以不殆
// 抓取所有经过代理请求的原始 system 原文，内存环形缓冲，重启清空
// 不记录 user message / API key（隐私）

const MAX = 10;
let _buf = [];
let _seq = 0;
let _stats = { total: 0, injected: 0, official: 0 };

// 把 system（字符串/数组/openai数组包装）标准化成纯文本
function normalizeSystem(sys, format) {
  if (sys == null) return { text: "", len: 0 };
  // openai 格式 getOrigSystem 返回 {type:"openai-array", items, text}
  if (format === "openai" && sys && typeof sys === "object" && sys.type === "openai-array") {
    return { text: sys.text || "", len: (sys.text || "").length };
  }
  if (typeof sys === "string") return { text: sys, len: sys.length };
  if (Array.isArray(sys)) {
    const text = sys
      .map((b) => (b && typeof b === "object" ? b.text || "" : String(b)))
      .join("\n");
    return { text, len: text.length };
  }
  const text = String(sys);
  return { text, len: text.length };
}

function push(entry) {
  _seq++;
  _stats.total++;
  const isOfficial = entry.mode === "official";
  if (isOfficial) _stats.official++;
  else _stats.injected++;
  const orig = normalizeSystem(entry.originalSystem, entry.format);
  const inj = normalizeSystem(entry.injectedSystem, entry.format);
  _buf.push({
    seq: _seq,
    ts: Date.now(),
    format: entry.format,
    path: entry.path,
    model: entry.model || "",
    mode: entry.mode,
    activeTemplates: entry.activeTemplates || [],
    originalSystem: orig.text,
    originalLen: orig.len,
    injectedSystem: typeof inj.text === "string" ? inj.text : "",
    injectedLen: inj.len,
  });
  if (_buf.length > MAX) _buf.shift();
}

// 轻量列表：不含 system 全文
function list() {
  return [..._buf]
    .reverse()
    .map((c) => ({
      seq: c.seq,
      ts: c.ts,
      format: c.format,
      path: c.path,
      model: c.model,
      mode: c.mode,
      activeTemplates: c.activeTemplates,
      originalLen: c.originalLen,
      injectedLen: c.injectedLen,
    }));
}

function get(seq) {
  return _buf.find((c) => c.seq === parseInt(seq, 10)) || null;
}

function clear() {
  _buf = [];
}

function stats() {
  return { ..._stats, buffered: _buf.length };
}

module.exports = { push, list, get, clear, stats };
