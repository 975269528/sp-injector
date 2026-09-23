// lib/tokenScan.js · 从上游响应流中提取 token 用量 · 尽力而为,不改动转发字节
// 原理:在 pipe 之外挂一个只读 data 监听,滚动保留响应的头/尾各 256KB,
//       流结束后按 SSE 行 / 整体 JSON 两种策略解析 usage 字段。
// 支持三种协议格式的 usage 位置:
//   openai  chat.completions : usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
//   anthropic               : message_start(message.usage) + message_delta(usage.output_tokens) 或顶层 usage
//   responses               : response.usage.input_tokens / output_tokens

const MAX_HEAD = 256 * 1024;
const MAX_TAIL = 256 * 1024;

function _num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

// 从一个 usage 对象里取值(openai / responses / anthropic 键名兼容),已有值不覆盖
function _fromUsageObj(u, r) {
  if (!u || typeof u !== "object") return;
  r.tokIn = r.tokIn ?? _num(u.prompt_tokens) ?? _num(u.input_tokens);
  r.tokOut = r.tokOut ?? _num(u.completion_tokens) ?? _num(u.output_tokens);
  r.tokCacheRead =
    r.tokCacheRead ??
    _num(u.cache_read_input_tokens) ??
    _num(u.cached_tokens) ??
    _num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
  r.tokCacheCreate = r.tokCacheCreate ?? _num(u.cache_creation_input_tokens);
}

// 从单个 SSE data 载荷/JSON 对象里吸收 usage(各事件形态兼容)
function _absorb(obj, r) {
  if (!obj || typeof obj !== "object") return;
  if (obj.usage) _fromUsageObj(obj.usage, r);
  // anthropic message_start: {type:"message_start", message:{usage:{...}}}
  if (obj.type === "message_start" && obj.message) _fromUsageObj(obj.message.usage, r);
  // anthropic message_delta: {type:"message_delta", usage:{output_tokens}}
  if (obj.type === "message_delta" && obj.usage) {
    r.tokOut = r.tokOut ?? _num(obj.usage.output_tokens);
  }
  // responses: {response:{usage:{...}}}
  if (obj.response && obj.response.usage) _fromUsageObj(obj.response.usage, r);
}

// 扫描文本中的 SSE data: 行
function _scanSSE(text, r) {
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      _absorb(JSON.parse(payload), r);
    } catch {}
  }
}

// 创建只读采样器:push(chunk) 喂字节,result() 在流结束后取解析结果
function createTap(contentType) {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    push(chunk) {
      if (!chunk) return;
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      if (head.length < MAX_HEAD) {
        const take = Math.min(MAX_HEAD - head.length, chunk.length);
        head = Buffer.concat([head, chunk.subarray(0, take)]);
      }
      if (chunk.length >= MAX_TAIL) {
        tail = Buffer.from(chunk.subarray(chunk.length - MAX_TAIL));
      } else {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > MAX_TAIL) tail = tail.subarray(tail.length - MAX_TAIL);
      }
    },
    // 返回 {tokIn,tokOut,tokCacheRead,tokCacheCreate, errPreview}
    // token 未解析到时为 null;errPreview 为失败响应体前 300 字符(去换行)
    result() {
      const r = { tokIn: null, tokOut: null, tokCacheRead: null, tokCacheCreate: null };
      const text = head.toString("utf8") + "\n" + tail.toString("utf8");
      if (text.includes("data:")) _scanSSE(text, r);
      if (r.tokIn == null && r.tokOut == null) {
        // 非流式 JSON:整体解析取顶层 usage(openai/anthropic/responses 通用)
        try {
          _absorb(JSON.parse(head.toString("utf8")), r);
        } catch {}
      }
      const errPreview = head
        .toString("utf8")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      return { ...r, errPreview };
    },
  };
}

module.exports = { createTap };
