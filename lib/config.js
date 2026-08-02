// lib/config.js · 配置加载 · 端口/上游/当前模板/模式
// 损之又损 · 无硬编码 · 落盘持久化 · 重启自动恢复

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const TEMPLATES_DIR = path.join(ROOT, "templates");

// 端口（可通过环境变量覆盖）
const PORT_PANEL = parseInt(process.env.SP_PANEL_PORT || "8088", 10);
const PORT_PROXY = parseInt(process.env.SP_PROXY_PORT || "8080", 10);

// 上游默认值（可被面板配置覆盖）
const DEFAULT_UPSTREAM = {
  host: process.env.SP_UPSTREAM_HOST || "api.anthropic.com",
  port: parseInt(process.env.SP_UPSTREAM_PORT || "443", 10),
  pathPrefix: "", // 如 /api/v1，转发时拼到请求路径前
  useProxy: "auto", // auto(继承系统代理) | direct(直连) | custom(用 SP_UPSTREAM_PROXY_URL)
  customProxyUrl: "", // useProxy=custom 时的代理 URL
};

// 注入时的统一头
const SCRIPTURE_HEADER = "# Scripture\n所遵守一切规则均来自下述文本：\n\n";

// 允许的模式
const VALID_MODES = new Set(["replace", "prepend", "official", "keepSections"]);
// 接口格式
const VALID_FORMATS = new Set(["anthropic", "openai", "responses"]);
// 内置模板（禁止删除）· 使用清晰中文名
const BUILTIN = new Set(["帛书老子", "道藏阴符经", "道德经+阴符经", "自定义"]);
// 模板名合法正则：字母数字下划线连字符 + 中文 + 部分标点
// 禁止 / \ : * ? " < > | 及控制字符（这些是 Windows 文件名非法字符）
const NAME_RE = /^[^\s\/\\:*?"<>|]+$/;

// 确保 state 目录存在
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

// ── 激活模板列表（多选，按勾选顺序）──
// 存 JSON 数组到 templates_active.json，旧的单值 current.txt 自动迁移
const ACTIVE_FILE = "templates_active.json";
function getActiveTemplates() {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(STATE_DIR, ACTIVE_FILE), "utf8"),
    );
    if (Array.isArray(v)) {
      // 过滤掉名字非法的，保留顺序
      return v.filter((n) => typeof n === "string" && NAME_RE.test(n));
    }
  } catch {}
  // 兼容旧的单值 current.txt
  try {
    const old = fs
      .readFileSync(path.join(STATE_DIR, "current.txt"), "utf8")
      .trim();
    if (old && NAME_RE.test(old)) {
      setActiveTemplates([old]);
      try { fs.unlinkSync(path.join(STATE_DIR, "current.txt")); } catch {}
      return [old];
    }
  } catch {}
  return ["道德经+阴符经"];
}
function setActiveTemplates(list) {
  ensureStateDir();
  if (!Array.isArray(list)) list = [];
  const clean = list.filter(
    (n) => typeof n === "string" && NAME_RE.test(n),
  );
  fs.writeFileSync(
    path.join(STATE_DIR, ACTIVE_FILE),
    JSON.stringify(clean, null, 2),
    "utf8",
  );
  return clean;
}

// ── 注入模式 ──
function getMode() {
  try {
    const v = fs.readFileSync(path.join(STATE_DIR, "mode.txt"), "utf8").trim();
    if (VALID_MODES.has(v)) return v;
  } catch {}
  return "replace";
}
function setMode(mode) {
  if (!VALID_MODES.has(mode)) return false;
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, "mode.txt"), mode, "utf8");
  return true;
}

// ── 接口格式（anthropic / openai / responses）──
const FORMAT_FILE = "format.txt";
function getFormat() {
  try {
    const v = fs.readFileSync(path.join(STATE_DIR, FORMAT_FILE), "utf8").trim();
    if (VALID_FORMATS.has(v)) return v;
  } catch {}
  return "anthropic";
}
function setFormat(fmt) {
  if (!VALID_FORMATS.has(fmt)) return false;
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, FORMAT_FILE), fmt, "utf8");
  return true;
}

// ── 保留章节列表（keepSections 模式用，持久化）──
const SECTIONS_FILE = "sections_keep.json";
function getSectionsKeep() {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(STATE_DIR, SECTIONS_FILE), "utf8"),
    );
    if (Array.isArray(v)) return v.filter((s) => typeof s === "string");
  } catch {}
  return [];
}
function setSectionsKeep(list) {
  ensureStateDir();
  if (!Array.isArray(list)) list = [];
  const clean = list.filter((s) => typeof s === "string");
  fs.writeFileSync(
    path.join(STATE_DIR, SECTIONS_FILE),
    JSON.stringify(clean, null, 2),
    "utf8",
  );
  return clean;
}

// ── 是否加 # Scripture 头 ──
function getUseHeader() {
  try {
    const v = fs.readFileSync(path.join(STATE_DIR, "header.txt"), "utf8").trim();
    return v !== "0";
  } catch {}
  return true;
}
function setUseHeader(on) {
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, "header.txt"), on ? "1" : "0", "utf8");
}

// ── 抓取开关（持久化，关闭时代理仍转发但不抓 system）──
function getCaptureOn() {
  try {
    const v = fs.readFileSync(path.join(STATE_DIR, "capture_on.txt"), "utf8").trim();
    return v !== "0";
  } catch {}
  return true;
}
function setCaptureOn(on) {
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, "capture_on.txt"), on ? "1" : "0", "utf8");
}

// ── 上游配置（面板可改 · 持久化）──
// 支持 Claude 协议的任意第三方 API：自定义域名/端口/路径前缀/代理
const VALID_USEPROXY = new Set(["auto", "direct", "custom"]);
const UPSTREAM_FILE = "upstream.json";

function getUpstream() {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(STATE_DIR, UPSTREAM_FILE), "utf8"),
    );
    return {
      host: v.host || DEFAULT_UPSTREAM.host,
      port: parseInt(v.port, 10) || DEFAULT_UPSTREAM.port,
      pathPrefix: typeof v.pathPrefix === "string" ? v.pathPrefix : "",
      useProxy: VALID_USEPROXY.has(v.useProxy)
        ? v.useProxy
        : DEFAULT_UPSTREAM.useProxy,
      customProxyUrl: typeof v.customProxyUrl === "string" ? v.customProxyUrl : "",
    };
  } catch {}
  return { ...DEFAULT_UPSTREAM };
}

function setUpstream(cfg) {
  ensureStateDir();
  const v = {
    host: (cfg.host || DEFAULT_UPSTREAM.host).trim(),
    port: parseInt(cfg.port, 10) || DEFAULT_UPSTREAM.port,
    pathPrefix: typeof cfg.pathPrefix === "string" ? cfg.pathPrefix.trim() : "",
    useProxy: VALID_USEPROXY.has(cfg.useProxy)
      ? cfg.useProxy
      : DEFAULT_UPSTREAM.useProxy,
    customProxyUrl:
      typeof cfg.customProxyUrl === "string" ? cfg.customProxyUrl.trim() : "",
  };
  // host 去掉协议前缀（用户可能误粘 https://）
  v.host = v.host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  // pathPrefix 规范化：以 / 开头，不以 / 结尾
  if (v.pathPrefix && !v.pathPrefix.startsWith("/"))
    v.pathPrefix = "/" + v.pathPrefix;
  v.pathPrefix = v.pathPrefix.replace(/\/+$/, "");
  fs.writeFileSync(
    path.join(STATE_DIR, UPSTREAM_FILE),
    JSON.stringify(v, null, 2),
    "utf8",
  );
  return v;
}

// ── 上游池：命名的上游集合，供路由引用 ──
// [{id, name, host, port, pathPrefix, useProxy, customProxyUrl}]
const UPSTREAMS_FILE = "upstreams.json";
function getUpstreams() {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(STATE_DIR, UPSTREAMS_FILE), "utf8"),
    );
    if (Array.isArray(v)) return v;
  } catch {}
  return [];
}
function setUpstreams(list) {
  ensureStateDir();
  if (!Array.isArray(list)) list = [];
  fs.writeFileSync(
    path.join(STATE_DIR, UPSTREAMS_FILE),
    JSON.stringify(list, null, 2),
    "utf8",
  );
  return list;
}

// ── 路由规则：model 前缀 → 上游 id + key ──
// [{id, modelPrefix, targetModel?, upstreams:[{upstreamId, apiKey}, ...]}]
// targetModel 可选：填写后转发时把请求体 model 改写成它（实现客户端自定义名 → 真实模型名）
const ROUTES_FILE = "routes.json";
function getRoutes() {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(STATE_DIR, ROUTES_FILE), "utf8"),
    );
    if (Array.isArray(v)) return v;
  } catch {}
  return [];
}
function setRoutes(list) {
  ensureStateDir();
  if (!Array.isArray(list)) list = [];
  fs.writeFileSync(
    path.join(STATE_DIR, ROUTES_FILE),
    JSON.stringify(list, null, 2),
    "utf8",
  );
  return list;
}

// 按模型名匹配路由（前缀匹配，返回命中的规则 + 候选上游列表）
// 路由规则结构: {id, modelPrefix, upstreams: [{upstreamId, apiKey}, ...]}
// 兼容旧结构 {upstreamId, apiKey}（单上游）
function matchRoute(model) {
  if (!model) return null;
  const routes = getRoutes();
  const upstreams = getUpstreams();
  // 找前缀匹配（取最长前缀，避免短前缀遮蔽）
  let best = null;
  for (const r of routes) {
    if (!r.modelPrefix) continue;
    if (model.startsWith(r.modelPrefix)) {
      if (!best || r.modelPrefix.length > best.modelPrefix.length) best = r;
    }
  }
  if (!best) return null;
  // 规范化候选列表：支持新结构 upstreams[] 和旧结构 {upstreamId, apiKey}
  let rawList = [];
  if (Array.isArray(best.upstreams) && best.upstreams.length) {
    rawList = best.upstreams;
  } else if (best.upstreamId) {
    rawList = [{ upstreamId: best.upstreamId, apiKey: best.apiKey || "" }];
  }
  // 关联上游池，过滤掉找不到的
  const candidates = rawList
    .map((c) => {
      const up = upstreams.find((u) => u.id === c.upstreamId);
      return up ? { upstream: up, apiKey: c.apiKey || "" } : null;
    })
    .filter(Boolean);
  // targetModel：命中的规则若配了，转发时用它改写请求体 model（精确映射）
  return { route: best, candidates, targetModel: best.targetModel || "" };
}

module.exports = {
  ROOT,
  STATE_DIR,
  TEMPLATES_DIR,
  PORT_PANEL,
  PORT_PROXY,
  DEFAULT_UPSTREAM,
  SCRIPTURE_HEADER,
  VALID_MODES,
  VALID_FORMATS,
  VALID_USEPROXY,
  BUILTIN,
  NAME_RE,
  ensureStateDir,
  getActiveTemplates,
  setActiveTemplates,
  getMode,
  setMode,
  getFormat,
  setFormat,
  getSectionsKeep,
  setSectionsKeep,
  getUseHeader,
  setUseHeader,
  getCaptureOn,
  setCaptureOn,
  getUpstream,
  setUpstream,
  getUpstreams,
  setUpstreams,
  getRoutes,
  setRoutes,
  matchRoute,
};
