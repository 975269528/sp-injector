// proxy.js · sp-injector · 道生一 · 双端口 · 经文即一切
// 端口 8080 = 代理入口（拦截 ZCode 请求，改写 system，转发 Anthropic）
// 端口 8088 = Web 面板（模板管理 + 日志 + 模式切换）
// 单进程 · 共享内存状态 · 改模板立即生效

const http = require("http");
const fs = require("fs");
const path = require("path");
const cfg = require("./lib/config");
const tpl = require("./lib/templates");
const log = require("./lib/logger");
const capture = require("./lib/capture");
const sectionParser = require("./lib/sectionParser");
const { forward } = require("./lib/auth-proxy");

const { PORT_PANEL, PORT_PROXY } = cfg;

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function ts() {
  return new Date().toISOString();
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 50 * 1024 * 1024) {
        // 50MB 上限
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 安全解码 URL 路径参数（模板名支持中文）
function dec(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 把模板文本按当前配置包装（加 # Scripture 头）
function wrapTemplate(text) {
  if (cfg.getUseHeader()) {
    return cfg.SCRIPTURE_HEADER + text;
  }
  return text;
}

// ═══════════════════════════════════════════════════════════
// 代理服务器（端口 8080）· 核心改写
// ═══════════════════════════════════════════════════════════

// 解析上游：有路由规则则按 model 路由（返回候选列表），无规则则用默认上游
// 返回 { candidates, targetModel } 或 { error, code }
// targetModel：命中的路由规则若配了，转发时用它改写请求体 model（精确映射）
function resolveUpstream(body) {
  let model = "";
  try {
    const o = JSON.parse(body.toString("utf8"));
    model = o.model || "";
  } catch {}
  const matched = cfg.matchRoute(model);
  if (matched) {
    if (!matched.candidates.length) {
      return { error: "route matched but no valid upstream: " + matched.route.upstreamId, code: 502 };
    }
    return { candidates: matched.candidates, targetModel: matched.targetModel || "" };
  }
  // 无路由规则时：若存在任何路由配置，则要求必须命中（拒绝）
  if (cfg.getRoutes().length > 0) {
    return {
      error: `no route matched model "${model}". please add a route for this model.`,
      code: 404,
    };
  }
  // 完全没配路由 → 用默认上游（作为单一候选）
  return { candidates: [{ upstream: cfg.getUpstream(), apiKey: "" }], targetModel: "" };
}

const proxyServer = http.createServer(async (req, res) => {
  const reqPath = req.url || "/";
  const method = req.method || "GET";

  // ── 本地端点 ──
  if (reqPath === "/__health") {
    return sendJson(res, 200, {
      ok: true,
      service: "sp-injector",
      ts: ts(),
      format: cfg.getFormat(),
      mode: cfg.getMode(),
      activeTemplates: cfg.getActiveTemplates(),
      sectionsKeep: cfg.getSectionsKeep(),
      useHeader: cfg.getUseHeader(),
      captureOn: cfg.getCaptureOn(),
      stats: log.stats(),
    });
  }
  if (reqPath === "/__state") {
    const up = cfg.getUpstream();
    const sysProxy = require("./lib/auth-proxy").detectSystemProxy();
    const effProxy =
      up.useProxy === "custom"
        ? up.customProxyUrl || null
        : up.useProxy === "auto"
          ? sysProxy || null
          : null;
    return sendJson(res, 200, {
      format: cfg.getFormat(),
      mode: cfg.getMode(),
      activeTemplates: cfg.getActiveTemplates(),
      sectionsKeep: cfg.getSectionsKeep(),
      useHeader: cfg.getUseHeader(),
      captureOn: cfg.getCaptureOn(),
      upstream: up,
      effective_proxy: effProxy,
      stats: log.stats(),
    });
  }

  // ── 判断是否为聊天接口（按当前接口格式）──
  const fmt = cfg.getFormat();
  const ENDPOINTS = {
    anthropic: ["/v1/messages"],
    openai: ["/chat/completions", "/v1/chat/completions"],
    responses: ["/responses", "/v1/responses"],
  };
  const injectablePaths = ENDPOINTS[fmt] || ENDPOINTS.anthropic;
  const isInjectable =
    method === "POST" &&
    injectablePaths.some(
      (p) => reqPath === p || reqPath.startsWith(p + "?") || reqPath.startsWith(p + "/"),
    );

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: "bad body", detail: e.message });
  }

  if (!isInjectable) {
    // 非聊天路径：原样转发（仍按 model 路由）
    const u = resolveUpstream(body);
    if (u.error) return sendJson(res, u.code || 502, { error: u.error });
    return forward(req, body, res, u.candidates, (upstreamRes) => {
      relayResponse(upstreamRes, res);
    });
  }

  // ── 核心：按接口格式改写 system ──
  let obj;
  try {
    obj = JSON.parse(body.toString("utf8"));
  } catch (e) {
    console.error(`[${ts()}] body parse fail, passthrough: ${e.message}`);
    const u = resolveUpstream(body);
    if (u.error) return sendJson(res, u.code || 502, { error: u.error });
    return forward(req, body, res, u.candidates, (upstreamRes) => {
      relayResponse(upstreamRes, res);
    });
  }

  const mode = cfg.getMode();

  // 取原始 system（按格式不同位置）· 在 official 判断之前先取，供抓取用
  const fmt2 = cfg.getFormat();
  function getOrigSystem(o) {
    if (fmt2 === "openai") {
      // messages 数组里 role=system 的内容
      if (Array.isArray(o.messages)) {
        const sm = o.messages.filter((m) => m && m.role === "system");
        if (sm.length)
          return {
            type: "openai-array",
            items: sm,
            text: sm
              .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
              .join("\n"),
          };
      }
      return null;
    }
    if (fmt2 === "responses") {
      // instructions 字段（字符串）
      return typeof o.instructions === "string" ? o.instructions : null;
    }
    // anthropic: system 字段（字符串或数组）
    return o.system;
  }

  const originalSystem = getOrigSystem(obj);
  const origPrev = log.previewSystem(originalSystem);

  // official 模式：抓取原始 system 后原样透传（最有价值：能看到官方原文）
  // 注意：official 不注入 system，但路由与模型映射能力仍生效
  if (mode === "official") {
    if (cfg.getCaptureOn()) {
      capture.push({
        format: fmt2,
        path: reqPath,
        model: obj.model || "",
        mode,
        activeTemplates: [],
        originalSystem,
        injectedSystem: originalSystem, // official 不改，前后一致
      });
    }
    console.log(`[${ts()}] official mode, captured+passthrough ${reqPath}`);
    const uOff = resolveUpstream(body);
    if (uOff.error) return sendJson(res, uOff.code || 502, { error: uOff.error });
    // 模型映射：targetModel 有值则改写请求体 model
    let offBody = body;
    if (uOff.targetModel && obj.model !== uOff.targetModel) {
      obj.model = uOff.targetModel;
      offBody = Buffer.from(JSON.stringify(obj), "utf8");
    }
    return forward(req, offBody, res, uOff.candidates, (upstreamRes) => {
      relayResponse(upstreamRes, res);
    });
  }

  // 多模板拼接：按 activeTemplates 顺序读，合并
  const activeList = cfg.getActiveTemplates();
  const tplTexts = [];
  for (const name of activeList) {
    try {
      const txt = tpl.read(name);
      if (txt) tplTexts.push({ name, text: txt });
    } catch (e) {
      console.error(`[${ts()}] template read fail (${name}): ${e.message}`);
    }
  }
  const merged = tplTexts.map((t) => t.text).join("\n\n---\n\n");
  const wrapped = wrapTemplate(merged);
  const tplNames = tplTexts.map((t) => t.name).join("+");

  // keepSections 模式：经文 + 保留的官方章节
  let finalText = wrapped;
  let keptInfo = "";
  if (mode === "keepSections") {
    // 把 originalSystem 转纯文本
    let origText = "";
    if (typeof originalSystem === "string") origText = originalSystem;
    else if (originalSystem && originalSystem.type === "openai-array") origText = originalSystem.text || "";
    else if (Array.isArray(originalSystem))
      origText = originalSystem.map((b) => (b && b.text) || "").join("\n");
    const sections = sectionParser.parseSections(origText);
    const keep = cfg.getSectionsKeep();
    const kept = sectionParser.extractKept(sections, keep);
    if (kept) {
      finalText = wrapped + "\n\n---\n\n" + kept;
      keptInfo = ` (保留${keep.length}章:${keep.join(",")})`;
    } else {
      keptInfo = ` (无保留章节,仅经文)`;
    }
  }

  // 写回 system（按格式不同位置）
  function applySystem(o, newText) {
    if (fmt2 === "openai") {
      // 重组 messages：新 system 放最前，删除原 system 消息
      const rest = (o.messages || []).filter((m) => !(m && m.role === "system"));
      let newMsgs;
      if (mode === "prepend" && originalSystem && originalSystem.items) {
        // 模板在前 + 原 system 消息保留在后
        newMsgs = [{ role: "system", content: newText }, ...originalSystem.items, ...rest];
      } else {
        newMsgs = [{ role: "system", content: newText }, ...rest];
      }
      o.messages = newMsgs;
    } else if (fmt2 === "responses") {
      if (mode === "prepend" && typeof originalSystem === "string") {
        o.instructions = newText + "\n\n" + originalSystem;
      } else {
        o.instructions = newText;
      }
    } else {
      // anthropic
      if (mode === "prepend" && originalSystem) {
        if (typeof originalSystem === "string") {
          o.system = newText + "\n\n" + originalSystem;
        } else if (Array.isArray(originalSystem)) {
          o.system = [{ type: "text", text: newText }, ...originalSystem];
        } else {
          o.system = newText;
        }
      } else {
        o.system = newText;
      }
    }
  }

  applySystem(obj, finalText);

  // 模型映射：在序列化前按命中规则的 targetModel 改写请求体 model
  // 注意必须用原始 body 解析路由——此时 obj.model 仍是客户端原始名（路由匹配依据）
  const uInj = resolveUpstream(body);
  if (uInj.error) return sendJson(res, uInj.code || 502, { error: uInj.error });
  if (uInj.targetModel && obj.model !== uInj.targetModel) {
    obj.model = uInj.targetModel;
  }

  // 抓取：原始 system + 改写后 system（含保留章节）
  if (cfg.getCaptureOn()) {
    capture.push({
      format: fmt2,
      path: reqPath,
      model: obj.model || "",
      mode,
      activeTemplates: activeList,
      originalSystem,
      injectedSystem: finalText,
    });
  }

  const newBody = Buffer.from(JSON.stringify(obj), "utf8");
  const newPrev = log.previewSystem(finalText);

  log.push({
    path: reqPath,
    method,
    injected: true,
    format: fmt2,
    mode,
    templateName: tplNames,
    templateCount: tplTexts.length,
    templateChars: merged.length,
    originalLen: origPrev.len,
    newLen: newPrev.len,
    sampleOrig: origPrev.sample,
    sampleNew: newPrev.sample,
  });

  console.log(
    `[${ts()}] inject ${reqPath} fmt=${fmt2} mode=${mode} tpl=${tplNames}(${merged.length}字,${tplTexts.length}个) system ${origPrev.len}→${newPrev.len}字${keptInfo}`,
  );

  forward(req, newBody, res, uInj.candidates, (upstreamRes) => {
    relayResponse(upstreamRes, res);
  });
});

// 把上游响应头+流原样转回客户端（SSE 不动一字节）
function relayResponse(upstreamRes, clientRes) {
  const headers = { ...upstreamRes.headers };
  // hop-by-hop 头不转发
  delete headers["connection"];
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  try {
    clientRes.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(clientRes);
  } catch (e) {
    console.error(`[${ts()}] relay error: ${e.message}`);
    try {
      clientRes.end();
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
// Web 面板服务器（端口 8088）· JSON API + 静态资源
// ═══════════════════════════════════════════════════════════

const PANEL_DIR = path.join(__dirname, "panel");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/" || urlPath === "/index.html") {
    urlPath = "/index.html";
  } else if (urlPath.startsWith("/panel/")) {
    urlPath = urlPath.slice("/panel".length); // 去掉 /panel 前缀
  }
  // 防 .. 路径穿越
  const filePath = path.join(PANEL_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PANEL_DIR)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const panelServer = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const method = req.method || "GET";

  // CORS（本地调试方便）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ── 静态资源 ──
  if (
    method === "GET" &&
    (urlPath === "/" ||
      urlPath === "/index.html" ||
      urlPath.startsWith("/panel/") ||
      urlPath.startsWith("/index"))
  ) {
    return serveStatic(req, res);
  }

  // ── API 路由 ──
  // GET /api/templates
  if (method === "GET" && urlPath === "/api/templates") {
    return sendJson(res, 200, { templates: tpl.list() });
  }

  // GET /api/templates/:name
  let m;
  if ((m = urlPath.match(/^\/api\/templates\/([^/]+)$/)) && method === "GET") {
    const name = dec(m[1]);
    try {
      return sendJson(res, 200, { name, content: tpl.read(name) });
    } catch (e) {
      return sendJson(res, 404, { error: e.message });
    }
  }

  // POST /api/templates/:name  {content}  保存
  if ((m = urlPath.match(/^\/api\/templates\/([^/]+)$/)) && method === "POST") {
    try {
      const body = await readBody(req);
      const { content } = JSON.parse(body.toString("utf8"));
      return sendJson(res, 200, tpl.save(dec(m[1]), content || ""));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // PUT /api/templates/new/:name  新建
  if (
    (m = urlPath.match(/^\/api\/templates\/new\/([^/]+)$/)) &&
    method === "PUT"
  ) {
    try {
      return sendJson(res, 200, tpl.create(dec(m[1])));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // DELETE /api/templates/:name  删除
  if (
    (m = urlPath.match(/^\/api\/templates\/([^/]+)$/)) &&
    method === "DELETE"
  ) {
    try {
      return sendJson(res, 200, tpl.remove(dec(m[1])));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // GET /api/state
  if (method === "GET" && urlPath === "/api/state") {
    const up = cfg.getUpstream();
    const sysProxy = require("./lib/auth-proxy").detectSystemProxy();
    const effProxy =
      up.useProxy === "custom"
        ? up.customProxyUrl || null
        : up.useProxy === "auto"
          ? sysProxy || null
          : null;
    return sendJson(res, 200, {
      format: cfg.getFormat(),
      mode: cfg.getMode(),
      activeTemplates: cfg.getActiveTemplates(),
      sectionsKeep: cfg.getSectionsKeep(),
      useHeader: cfg.getUseHeader(),
      captureOn: cfg.getCaptureOn(),
      upstream: up,
      effective_proxy: effProxy,
      stats: log.stats(),
    });
  }

  // GET /api/upstream  读上游配置
  if (method === "GET" && urlPath === "/api/upstream") {
    return sendJson(res, 200, { upstream: cfg.getUpstream() });
  }

  // POST /api/upstream  存上游配置
  if (method === "POST" && urlPath === "/api/upstream") {
    try {
      const body = await readBody(req);
      const obj = JSON.parse(body.toString("utf8"));
      const saved = cfg.setUpstream(obj || {});
      return sendJson(res, 200, { ok: true, upstream: saved });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // ── 路由配置 ──
  // GET /api/routing  读上游池 + 路由规则
  if (method === "GET" && urlPath === "/api/routing") {
    return sendJson(res, 200, {
      upstreams: cfg.getUpstreams(),
      routes: cfg.getRoutes(),
    });
  }

  // POST /api/routing/upstreams  {upstreams:[...], force?}  存整个上游池
  // 保护：提交空数组但当前已有数据时，必须带 force:true（防误清空）
  if (method === "POST" && urlPath === "/api/routing/upstreams") {
    try {
      const body = await readBody(req);
      const obj = JSON.parse(body.toString("utf8"));
      const incoming = obj.upstreams || [];
      const existing = cfg.getUpstreams();
      if (
        incoming.length === 0 &&
        existing.length > 0 &&
        obj.force !== true
      ) {
        return sendJson(res, 409, {
          error:
            "将清空 " +
            existing.length +
            " 个上游。若确认，请带 force:true 重新提交。",
          count: existing.length,
        });
      }
      const saved = cfg.setUpstreams(incoming);
      return sendJson(res, 200, { ok: true, upstreams: saved });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // POST /api/routing/routes  {routes:[...], force?}  存整个路由规则
  // 保护：提交空数组但当前已有数据时，必须带 force:true（防误清空）
  if (method === "POST" && urlPath === "/api/routing/routes") {
    try {
      const body = await readBody(req);
      const obj = JSON.parse(body.toString("utf8"));
      const incoming = obj.routes || [];
      const existing = cfg.getRoutes();
      if (
        incoming.length === 0 &&
        existing.length > 0 &&
        obj.force !== true
      ) {
        return sendJson(res, 409, {
          error:
            "将清空 " +
            existing.length +
            " 条路由规则。若确认，请带 force:true 重新提交。",
          count: existing.length,
        });
      }
      const saved = cfg.setRoutes(incoming);
      return sendJson(res, 200, { ok: true, routes: saved });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // POST /api/state/templates  {names:[...]}  设置激活模板列表（多选，有序）
  if (method === "POST" && urlPath === "/api/state/templates") {
    try {
      const body = await readBody(req);
      const { names } = JSON.parse(body.toString("utf8"));
      if (!Array.isArray(names)) throw new Error("names must be array");
      // 校验每个模板存在 + 名字合法
      for (const n of names) {
        if (!cfg.NAME_RE.test(n)) throw new Error("invalid name: " + n);
        tpl.read(n);
      }
      const saved = cfg.setActiveTemplates(names);
      return sendJson(res, 200, { ok: true, activeTemplates: saved });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // POST /api/state/format  {format}
  if (method === "POST" && urlPath === "/api/state/format") {
    try {
      const body = await readBody(req);
      const { format } = JSON.parse(body.toString("utf8"));
      if (!cfg.setFormat(format)) throw new Error("invalid format");
      return sendJson(res, 200, { ok: true, format });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // POST /api/state/mode  {mode}
  if (method === "POST" && urlPath === "/api/state/mode") {
    try {
      const body = await readBody(req);
      const { mode } = JSON.parse(body.toString("utf8"));
      if (!cfg.setMode(mode)) throw new Error("invalid mode");
      return sendJson(res, 200, { ok: true, mode });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // POST /api/state/header  {on}
  if (method === "POST" && urlPath === "/api/state/header") {
    try {
      const body = await readBody(req);
      const { on } = JSON.parse(body.toString("utf8"));
      cfg.setUseHeader(!!on);
      return sendJson(res, 200, { ok: true, useHeader: !!on });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // POST /api/state/capture  {on}  抓取开关
  if (method === "POST" && urlPath === "/api/state/capture") {
    try {
      const body = await readBody(req);
      const { on } = JSON.parse(body.toString("utf8"));
      cfg.setCaptureOn(!!on);
      return sendJson(res, 200, { ok: true, captureOn: !!on });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // GET /api/logs
  if (method === "GET" && urlPath === "/api/logs") {
    return sendJson(res, 200, { logs: log.list(), stats: log.stats() });
  }

  // POST /api/logs/clear
  if (method === "POST" && urlPath === "/api/logs/clear") {
    log.clear();
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/captures  抓取列表（轻量，不含全文）
  if (method === "GET" && urlPath === "/api/captures") {
    return sendJson(res, 200, { captures: capture.list(), stats: capture.stats() });
  }

  // GET /api/captures/:seq  单条详情（含全文）
  let cm;
  if ((cm = urlPath.match(/^\/api\/captures\/(\d+)$/)) && method === "GET") {
    const c = capture.get(cm[1]);
    if (!c) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { capture: c });
  }

  // POST /api/captures/clear
  if (method === "POST" && urlPath === "/api/captures/clear") {
    capture.clear();
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/sections  从最近一条抓取解析章节列表 + 当前 keep
  if (method === "GET" && urlPath === "/api/sections") {
    const all = capture.list();
    if (all.length === 0) {
      return sendJson(res, 200, { sections: [], keep: cfg.getSectionsKeep(), hasCapture: false });
    }
    const latest = capture.get(all[0].seq); // 最新一条
    const origText = latest ? latest.originalSystem : "";
    const sections = sectionParser.listTitles(sectionParser.parseSections(origText));
    return sendJson(res, 200, {
      sections,
      keep: cfg.getSectionsKeep(),
      hasCapture: true,
      fromSeq: latest ? latest.seq : null,
    });
  }

  // POST /api/sections/keep  {keep:[...]}  保存保留章节
  if (method === "POST" && urlPath === "/api/sections/keep") {
    try {
      const body = await readBody(req);
      const { keep } = JSON.parse(body.toString("utf8"));
      const saved = cfg.setSectionsKeep(Array.isArray(keep) ? keep : []);
      return sendJson(res, 200, { ok: true, keep: saved });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: "not found", path: urlPath });
});

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

proxyServer.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[FATAL] 端口 ${PORT_PROXY} 被占用`);
  } else {
    console.error(`[FATAL] proxy server error:`, e);
  }
  process.exit(1);
});
panelServer.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[FATAL] 端口 ${PORT_PANEL} 被占用`);
  } else {
    console.error(`[FATAL] panel server error:`, e);
  }
  process.exit(1);
});

proxyServer.listen(PORT_PROXY, "127.0.0.1", () => {
  console.log(`[sp-injector] 代理入口  : http://127.0.0.1:${PORT_PROXY}`);
});
panelServer.listen(PORT_PANEL, "127.0.0.1", () => {
  const up = cfg.getUpstream();
  const sysProxy = require("./lib/auth-proxy").detectSystemProxy();
  const effProxy =
    up.useProxy === "custom"
      ? up.customProxyUrl || "直连"
      : up.useProxy === "auto"
        ? sysProxy || "直连"
        : "直连";
  console.log(`[sp-injector] Web 面板  : http://127.0.0.1:${PORT_PANEL}`);
  console.log(`[sp-injector] 当前模板  : ${cfg.getActiveTemplates().join(" + ") || "(无)"} (${cfg.getMode()} 模式)`);
  console.log(
    `[sp-injector] 上游      : ${up.host}:${up.port}${up.pathPrefix} (${effProxy})`,
  );
  console.log(`[sp-injector] 上善若水 · 道法自然`);
});

// 优雅退出
process.on("SIGINT", () => {
  console.log("\n[sp-injector] 收到 SIGINT，关闭中...");
  proxyServer.close();
  panelServer.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  proxyServer.close();
  panelServer.close();
  process.exit(0);
});
