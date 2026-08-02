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

// 上游默认值（历史遗留，单数默认上游已废弃；保留供未使用场景兜底）
const DEFAULT_UPSTREAM = {
  host: process.env.SP_UPSTREAM_HOST || "api.anthropic.com",
  port: parseInt(process.env.SP_UPSTREAM_PORT || "443", 10),
  pathPrefix: "", // 如 /api/v1，转发时拼到请求路径前
  useProxy: "auto", // auto(继承系统代理) | direct(直连)
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

// ── 上游池：每个上游绑定自己的 apiKey + 模型列表 ──
// [{id, name, host, port, pathPrefix, useProxy, modelsPath, apiKey, models:[{name, contextK?}]}]
// apiKey 绑在上游上（不再在路由里）；modelsPath 为拉取模型列表的路径（默认 /models）
// useProxy 仅支持 auto(继承系统代理) / direct(直连)，已去掉 custom
const VALID_USEPROXY = new Set(["auto", "direct"]);
const UPSTREAMS_FILE = "upstreams.json";

// 读取上游池。首次读取时若检测到旧版 routes.json（key 绑在路由上），
// 自动迁移：把 key 搬到上游、把路由映射迁移到 model_mappings，并重命名旧文件。
// 幂等：以 state/.migrated_v2 标记防重复。
const MIGRATE_FLAG = ".migrated_v2";
const OLD_ROUTES_FILE = "routes.json";
const OLD_UPSTREAM_FILE = "upstream.json";
const MAPPINGS_FILE = "model_mappings.json";

function _readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

// 一次性迁移 v1(routes+单数upstream) → v2(upstreams 含 key + mappings)
function _migrateV2() {
  ensureStateDir();
  const flagPath = path.join(STATE_DIR, MIGRATE_FLAG);
  if (fs.existsSync(flagPath)) return; // 已迁移
  let migrated = false;

  // 1) 搬 key：routes[].upstreams[].apiKey → upstreams[].apiKey
  const oldRoutes = _readJson(OLD_ROUTES_FILE);
  let upstreams = getUpstreamsRaw();
  if (Array.isArray(oldRoutes) && oldRoutes.length && Array.isArray(upstreams)) {
    // 收集每个 upstreamId 的 key（同 id 多 key 取最后，记警告）
    const keyMap = new Map(); // id -> {key, count}
    for (const r of oldRoutes) {
      const rawList =
        Array.isArray(r.upstreams) && r.upstreams.length
          ? r.upstreams
          : r.upstreamId
            ? [{ upstreamId: r.upstreamId, apiKey: r.apiKey || "" }]
            : [];
      for (const c of rawList) {
        if (!c || !c.upstreamId) continue;
        const prev = keyMap.get(c.upstreamId);
        if (prev) {
          prev.count++;
          if (c.apiKey) prev.key = c.apiKey; // 取最后非空
        } else {
          keyMap.set(c.upstreamId, { key: c.apiKey || "", count: 1 });
        }
      }
    }
    let conflicts = 0;
    upstreams = upstreams.map((u) => {
      if (u.apiKey) return u; // 已有 key 不覆盖
      const entry = keyMap.get(u.id);
      if (entry) {
        if (entry.count > 1) conflicts++;
        return { ...u, apiKey: entry.key };
      }
      return u;
    });
    setUpstreamsRaw(upstreams);

    // 2) 路由映射 → model_mappings：modelPrefix 作 clientModel，upstreams 保留 id，targetModel 留空
    const mappings = [];
    for (const r of oldRoutes) {
      if (!r.modelPrefix) continue;
      const rawList =
        Array.isArray(r.upstreams) && r.upstreams.length
          ? r.upstreams
          : r.upstreamId
            ? [{ upstreamId: r.upstreamId }]
            : [];
      const ups = rawList
        .filter((c) => c && c.upstreamId)
        .map((c) => ({ upstreamId: c.upstreamId, targetModel: r.targetModel || "" }));
      if (ups.length) {
        mappings.push({
          id: "m_" + r.id || ("m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
          clientModel: r.modelPrefix,
          upstreams: ups,
        });
      }
    }
    if (mappings.length) setModelMappingsRaw(mappings);

    if (conflicts > 0) {
      console.warn(`[migrate] 检测到 ${conflicts} 个上游在多条路由有不同 key，取最后值`);
    }

    // 重命名旧文件（保留备查），不直接删
    try { fs.renameSync(path.join(STATE_DIR, OLD_ROUTES_FILE), path.join(STATE_DIR, OLD_ROUTES_FILE + ".migrated")); } catch {}
    migrated = true;
  }

  // 3) 单数默认 upstream.json：无 key 无实际用途，直接弃用（重命名保留）
  const oldSingle = path.join(STATE_DIR, OLD_UPSTREAM_FILE);
  if (fs.existsSync(oldSingle)) {
    try { fs.renameSync(oldSingle, oldSingle + ".migrated"); } catch {}
    console.log("[migrate] 旧版单数默认上游 upstream.json 已弃用（重命名为 .migrated）");
    migrated = true;
  }

  if (migrated) console.log("[migrate] v1→v2 路由数据迁移完成");
  fs.writeFileSync(flagPath, String(Date.now()), "utf8");
}

// raw 读写（不做迁移，供迁移逻辑内部用）
function getUpstreamsRaw() {
  const v = _readJson(UPSTREAMS_FILE);
  return Array.isArray(v) ? v : [];
}
function setUpstreamsRaw(list) {
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, UPSTREAMS_FILE), JSON.stringify(list, null, 2), "utf8");
  return list;
}
function getModelMappingsRaw() {
  const v = _readJson(MAPPINGS_FILE);
  return Array.isArray(v) ? v : [];
}
function setModelMappingsRaw(list) {
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, MAPPINGS_FILE), JSON.stringify(list, null, 2), "utf8");
  return list;
}

// 对外：读取上游池（触发迁移）
function getUpstreams() {
  _migrateV2();
  return getUpstreamsRaw();
}
// 对外：保存上游池（规范化 apiKey/models 字段）
function setUpstreams(list) {
  ensureStateDir();
  if (!Array.isArray(list)) list = [];
  const clean = list.map((u) => ({
    id: typeof u.id === "string" ? u.id : ("u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    name: typeof u.name === "string" ? u.name : "",
    host: String(u.host || "").replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
    port: parseInt(u.port, 10) || 443,
    pathPrefix: (() => {
      let p = typeof u.pathPrefix === "string" ? u.pathPrefix.trim() : "";
      if (p && !p.startsWith("/")) p = "/" + p;
      return p.replace(/\/+$/, "");
    })(),
    useProxy: VALID_USEPROXY.has(u.useProxy) ? u.useProxy : "direct",
    // 模型列表拉取路径：默认 /models（OpenAI 兼容），「拉取」时访问 pathPrefix + modelsPath
    modelsPath: (() => {
      let p = typeof u.modelsPath === "string" ? u.modelsPath.trim() : "";
      if (!p) return "/models"; // 默认 OpenAI 兼容路径
      if (!p.startsWith("/")) p = "/" + p;
      return p;
    })(),
    apiKey: typeof u.apiKey === "string" ? u.apiKey : "",
    models: Array.isArray(u.models) ? u.models.map((m) => ({ name: String(m.name || ""), contextK: m.contextK || null })).filter((m) => m.name) : [],
  }));
  setUpstreamsRaw(clean);
  return clean;
}

// ── 模型映射表：客户端精确 model 名 → 有序候选(上游+真实模型名) ──
// [{id, clientModel, mode?, upstreams:[{upstreamId, targetModel}, ...]}]
// mode 可选：填了则该映射用自己的注入模式覆盖全局；空/缺省则用全局 mode
// 精确匹配 clientModel；命中的候选按序故障转移，每个候选各自 targetModel
function getModelMappings() {
  _migrateV2();
  return getModelMappingsRaw();
}
function setModelMappings(list) {
  ensureStateDir();
  if (!Array.isArray(list)) list = [];
  const clean = list.map((m) => ({
    id: typeof m.id === "string" ? m.id : ("m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    clientModel: typeof m.clientModel === "string" ? m.clientModel : "",
    // mode 仅接受合法值，否则置空（空表示用全局）
    mode: VALID_MODES.has(m.mode) ? m.mode : "",
    upstreams: Array.isArray(m.upstreams)
      ? m.upstreams
          .filter((c) => c && c.upstreamId)
          .map((c) => ({ upstreamId: String(c.upstreamId), targetModel: typeof c.targetModel === "string" ? c.targetModel : "" }))
      : [],
  }));
  setModelMappingsRaw(clean);
  return clean;
}

// 按客户端 model 精确匹配映射，返回候选列表（关联上游池，注入 apiKey）
// 返回 { mapping, candidates:[{upstream, apiKey, targetModel}, ...] } 或 null
function matchMapping(model) {
  if (!model) return null;
  const mappings = getModelMappings();
  const upstreams = getUpstreamsRaw();
  const m = mappings.find((r) => r.clientModel && r.clientModel === model);
  if (!m) return null;
  const candidates = (m.upstreams || [])
    .map((c) => {
      const up = upstreams.find((u) => u.id === c.upstreamId);
      if (!up) return null;
      return { upstream: up, apiKey: up.apiKey || "", targetModel: c.targetModel || "" };
    })
    .filter(Boolean);
  return { mapping: m, candidates };
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
  getUpstreams,
  setUpstreams,
  getModelMappings,
  setModelMappings,
  matchMapping,
};
