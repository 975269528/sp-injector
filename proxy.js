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
const modelStats = require("./lib/modelStats");
const usageLog = require("./lib/usageLog");
const tokenScan = require("./lib/tokenScan");
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

// 解析上游：按客户端 model 精确匹配映射表
// 返回 { candidates:[{upstream, apiKey, targetModel}], effectiveMode, model } 或 { error, code }
// effectiveMode：映射自带 mode 优先，否则 undefined（调用方回退全局 mode）
// 无映射命中 → 404（需先在面板配置模型映射）
function resolveUpstream(body) {
  let model = "";
  try {
    const o = JSON.parse(body.toString("utf8"));
    model = o.model || "";
  } catch {}
  const matched = cfg.matchMapping(model);
  if (matched) {
    if (!matched.candidates.length) {
      return { error: "mapping matched but no valid upstream for: " + model, code: 502 };
    }
    return { candidates: matched.candidates, effectiveMode: matched.mapping.mode || "", model };
  }
  // 未命中映射：若已有映射配置，提示补配；若一条映射都没有，提示先配置
  const hint = cfg.getModelMappings().length > 0
    ? `no mapping for model "${model}". please add a mapping in the panel.`
    : `no model mappings configured. please add upstreams and mappings in the panel first.`;
  return { error: hint, code: 404 };
}

// ── OpenAI 兼容模型列表端点（供客户端自动获取模型，同 DeepSeek 风格）──
// GET /v1/models（或 /models）        → 全部可用模型
// GET /v1/models/:model（或 /models/:model） → 单个模型详情
// 模型来源：映射表的 clientModel（客户端请求本代理时填的 model 名）
const MODELS_CREATED = 1718900000; // 固定 created 时间戳（DeepSeek 官方同款做法）

// 由一条映射构造 OpenAI 模型对象；owned_by 取第一候选上游名，context_length 尽力补全
function modelEntry(mapping) {
  let ownedBy = "sp-injector";
  let contextLength = null;
  const first = (mapping.upstreams || [])[0];
  if (first) {
    const up = cfg.getUpstreams().find((u) => u.id === first.upstreamId);
    if (up) {
      ownedBy = up.name || up.host || ownedBy;
      const tm = (up.models || []).find((mm) => mm.name === first.targetModel);
      if (tm && typeof tm.contextK === "number" && tm.contextK > 0) {
        // contextK 语义为"千 token"（128 → 128K）；若存的是原始 token 数（≥4096）则原样使用
        contextLength = tm.contextK >= 4096 ? tm.contextK : tm.contextK * 1024;
      }
    }
  }
  const e = {
    id: mapping.clientModel,
    object: "model",
    created: MODELS_CREATED,
    owned_by: ownedBy,
  };
  if (contextLength) e.context_length = contextLength;
  return e;
}

// 命中模型端点则应答并返回 true；否则返回 false 交回主流程
function handleModelsEndpoint(reqPath, res) {
  const p = (reqPath || "").split("?")[0].replace(/\/+$/, ""); // 去 query + 尾斜杠
  if (p === "/v1/models" || p === "/models") {
    const data = cfg
      .getModelMappings()
      .filter((mp) => mp.clientModel)
      .map(modelEntry);
    sendJson(res, 200, { object: "list", data });
    return true;
  }
  const mm = p.match(/^\/(?:v1\/)?models\/([^/]+)$/);
  if (mm) {
    const name = dec(mm[1]);
    const found = cfg.getModelMappings().find((mp) => mp.clientModel === name);
    if (found) {
      sendJson(res, 200, modelEntry(found));
    } else {
      // OpenAI 风格错误体
      sendJson(res, 404, {
        error: {
          message: `The model '${name}' does not exist`,
          type: "invalid_request_error",
          param: null,
          code: "model_not_found",
        },
      });
    }
    return true;
  }
  return false;
}

const proxyServer = http.createServer(async (req, res) => {
  const startTs = Date.now(); // TTFB 起点:客户端请求到达(含 body 接收与故障转移重试)
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
    return sendJson(res, 200, {
      format: cfg.getFormat(),
      mode: cfg.getMode(),
      activeTemplates: cfg.getActiveTemplates(),
      sectionsKeep: cfg.getSectionsKeep(),
      useHeader: cfg.getUseHeader(),
      captureOn: cfg.getCaptureOn(),
      upstreamCount: cfg.getUpstreams().length,
      mappingCount: cfg.getModelMappings().length,
      stats: log.stats(),
    });
  }

  // ── OpenAI 兼容模型列表（GET /v1/models、/v1/models/:model）──
  // 必须在 readBody/上游转发之前拦截：这类 GET 请求没有 body.model，走转发只会得到 404
  if (method === "GET" && handleModelsEndpoint(reqPath, res)) return;

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

  // 解析映射（提前一次，贯穿后续分支复用）：用原始 body，此时 model 是客户端原始名（匹配依据）
  // targetModel 改写由 forward 层按各候选处理
  const resolved = resolveUpstream(body);
  if (resolved.error) return sendJson(res, resolved.code || 502, { error: resolved.error });

  // 注入模式：映射自带 mode 优先，否则用全局 mode
  const mode = resolved.effectiveMode || cfg.getMode();

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
    // resolved 已在前面解析完毕，模型映射由 forward 层按各候选 targetModel 改写
    return forward(req, body, res, resolved.candidates, (upstreamRes, won) => {
      relayResponse(upstreamRes, res, {
        model: resolved.model,
        targetModel: (won && won.targetModel) || "",
        upstream: (won && won.upstream && won.upstream.host) || "",
        mode,
        format: fmt2,
        path: reqPath,
        stream: obj.stream === true,
        start: startTs,
      });
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

  // resolved 已在前面解析完毕；targetModel 改写由 forward 层按各候选处理

  // 抓取：原始 system + 改写后 system（含保留章节）。model 记客户端原始名
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

  forward(req, newBody, res, resolved.candidates, (upstreamRes, won) => {
    relayResponse(upstreamRes, res, {
      model: resolved.model,
      targetModel: (won && won.targetModel) || "",
      upstream: (won && won.upstream && won.upstream.host) || "",
      mode,
      format: fmt2,
      path: reqPath,
      stream: obj.stream === true,
      start: startTs,
    });
  });
});

// 把上游响应头+流原样转回客户端（SSE 不动一字节）
// meta: {model,targetModel,upstream,mode,format,path,stream,start} 有值时记录流水与统计
// token 用量通过只读采样器从响应流中尽力解析,不影响转发内容
function relayResponse(upstreamRes, clientRes, meta) {
  const headers = { ...upstreamRes.headers };
  // hop-by-hop 头不转发
  delete headers["connection"];
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  const tap = tokenScan.createTap(upstreamRes.headers["content-type"]);
  upstreamRes.on("data", (c) => tap.push(c));
  try {
    clientRes.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(clientRes);
  } catch (e) {
    console.error(`[${ts()}] relay error: ${e.message}`);
    try {
      clientRes.end();
    } catch {}
  }
  if (meta && meta.model) {
    const ttfb = Date.now() - meta.start;
    const ok = (upstreamRes.statusCode || 500) < 400;
    // close 在流结束/客户端中断时都会触发,保证不漏记
    upstreamRes.once("close", () => {
      const u = tap.result();
      modelStats.record(meta.model, ttfb, ok, u);
      usageLog.append({
        model: meta.model,
        targetModel: meta.targetModel,
        upstream: meta.upstream,
        mode: meta.mode,
        format: meta.format,
        path: meta.path,
        status: upstreamRes.statusCode || 0,
        ok,
        stream: meta.stream,
        ttfbMs: ttfb,
        totalMs: Date.now() - meta.start,
        tokIn: u.tokIn,
        tokOut: u.tokOut,
        tokCacheRead: u.tokCacheRead,
        tokCacheCreate: u.tokCacheCreate,
        errMsg: ok ? "" : u.errPreview,
      });
    });
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
  ".svg": "image/svg+xml",
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
    // 本地面板不缓存:改版后刷新即生效,无需清浏览器缓存
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
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
    return sendJson(res, 200, {
      format: cfg.getFormat(),
      mode: cfg.getMode(),
      activeTemplates: cfg.getActiveTemplates(),
      sectionsKeep: cfg.getSectionsKeep(),
      useHeader: cfg.getUseHeader(),
      captureOn: cfg.getCaptureOn(),
      upstreamCount: cfg.getUpstreams().length,
      mappingCount: cfg.getModelMappings().length,
      stats: log.stats(),
    });
  }

  // ── 上游池 ──
  // GET /api/upstreams  读上游池（每个上游含自己的 apiKey + models）
  if (method === "GET" && urlPath === "/api/upstreams") {
    return sendJson(res, 200, { upstreams: cfg.getUpstreams() });
  }

  // POST /api/upstreams  {upstreams:[...], force?}  存整个上游池
  // 保护：提交空数组但当前已有数据时，必须带 force:true（防误清空）
  if (method === "POST" && urlPath === "/api/upstreams") {
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

  // POST /api/upstreams/:id/fetch-models  自动拉取该上游支持的模型列表
  // 用上游已填的 apiKey 调其 OpenAI 兼容 /models 端点，返回模型列表
  if ((m = urlPath.match(/^\/api\/upstreams\/([^/]+)\/fetch-models$/)) && method === "POST") {
    try {
      const id = dec(m[1]);
      const up = cfg.getUpstreams().find((u) => u.id === id);
      if (!up) return sendJson(res, 404, { error: "upstream not found: " + id });
      if (!up.apiKey) return sendJson(res, 400, { error: "请先填写该上游的 API Key" });
      const { fetchModels } = require("./lib/auth-proxy");
      const result = await fetchModels(up);
      // 拉取成功：把 models 写回该上游（合并保留旧 contextK）
      const all = cfg.getUpstreams();
      const idx = all.findIndex((u) => u.id === id);
      const oldModels = (all[idx].models || []).filter(Boolean);
      const merged = result.models.map((nm) => {
        const old = oldModels.find((om) => om.name === nm.name);
        return { name: nm.name, contextK: (old && old.contextK) || nm.contextK || null };
      });
      all[idx].models = merged;
      cfg.setUpstreams(all);
      return sendJson(res, 200, { ok: true, models: merged, count: merged.length });
    } catch (e) {
      return sendJson(res, 502, { error: "拉取失败: " + e.message });
    }
  }

  // ── 模型映射表 ──
  // GET /api/mappings  读映射表
  if (method === "GET" && urlPath === "/api/mappings") {
    return sendJson(res, 200, { mappings: cfg.getModelMappings() });
  }

  // POST /api/mappings  {mappings:[...], force?}  存整个映射表
  // 保护：提交空数组但当前已有数据时，必须带 force:true（防误清空）
  if (method === "POST" && urlPath === "/api/mappings") {
    try {
      const body = await readBody(req);
      const obj = JSON.parse(body.toString("utf8"));
      const incoming = obj.mappings || [];
      const existing = cfg.getModelMappings();
      if (
        incoming.length === 0 &&
        existing.length > 0 &&
        obj.force !== true
      ) {
        return sendJson(res, 409, {
          error:
            "将清空 " +
            existing.length +
            " 条映射。若确认，请带 force:true 重新提交。",
          count: existing.length,
        });
      }
      const saved = cfg.setModelMappings(incoming);
      return sendJson(res, 200, { ok: true, mappings: saved });
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

  // GET /api/model-stats  按模型聚合 + 最近一分钟 RPM/TPM
  // 可选 from/to(YYYY-MM-DD,含两端):返回 custom 字段为该日期区间的聚合
  if (method === "GET" && urlPath === "/api/model-stats") {
    const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const from = qs.get("from") || "";
    const to = qs.get("to") || "";
    const lm = usageLog.lastMinute();
    const out = {
      today: modelStats.query("today"),
      all: modelStats.query("all"),
      rpm: lm.rpm,
      tpm: lm.tpm,
    };
    if (DATE_RE.test(from) && DATE_RE.test(to) && from <= to) {
      out.custom = modelStats.rangeQuery(from, to);
    }
    return sendJson(res, 200, out);
  }

  // GET /api/model-stats/trend  近 24 小时逐小时调用/token 序列(趋势图)
  if (method === "GET" && urlPath === "/api/model-stats/trend") {
    return sendJson(res, 200, { hours: modelStats.trend24h() });
  }

  // GET /api/usage/trend?fromTs=&toTs=  波浪图:每模型按时间桶的 次数/token 序列
  if (method === "GET" && urlPath === "/api/usage/trend") {
    const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
    return sendJson(res, 200, usageLog.series({
      fromTs: qs.get("fromTs"),
      toTs: qs.get("toTs"),
    }));
  }

  // POST /api/model-stats/clear  清空模型统计
  if (method === "POST" && urlPath === "/api/model-stats/clear") {
    modelStats.reset();
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/usage  调用流水:分页列表 + 汇总统计 + 模型下拉选项
  // 参数: page, pageSize, model, status(ok|err), range(today|7d|all)
  if (method === "GET" && urlPath === "/api/usage") {
    const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
    return sendJson(res, 200, usageLog.list({
      page: qs.get("page"),
      pageSize: qs.get("pageSize"),
      model: qs.get("model") || "",
      status: qs.get("status") || "",
      range: qs.get("range") || "all",
    }));
  }

  // POST /api/usage/clear  清空调用流水
  if (method === "POST" && urlPath === "/api/usage/clear") {
    usageLog.clear();
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

// 单个 server 监听：失败 reject（EADDRINUSE 等），成功 resolve
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

// 启动双 server（供 Electron 主进程调用；端口可注入）
// 返回 Promise<{ proxyServer, panelServer, ports: { proxy, panel } }>
async function startProxy(opts = {}) {
  const proxyPort = parseInt(opts.proxyPort || PORT_PROXY, 10);
  const panelPort = parseInt(opts.panelPort || PORT_PANEL, 10);

  try {
    await listenOn(proxyServer, proxyPort);
  } catch (e) {
    if (e.code === "EADDRINUSE") console.error(`[FATAL] 端口 ${proxyPort} 被占用`);
    else console.error(`[FATAL] proxy server error:`, e);
    throw e;
  }
  console.log(`[sp-injector] 代理入口  : http://127.0.0.1:${proxyPort}`);

  try {
    await listenOn(panelServer, panelPort);
  } catch (e) {
    proxyServer.close();
    if (e.code === "EADDRINUSE") console.error(`[FATAL] 端口 ${panelPort} 被占用`);
    else console.error(`[FATAL] panel server error:`, e);
    throw e;
  }

  console.log(`[sp-injector] Web 面板  : http://127.0.0.1:${panelPort}`);
  console.log(`[sp-injector] 当前模板  : ${cfg.getActiveTemplates().join(" + ") || "(无)"} (${cfg.getMode()} 模式)`);
  console.log(
    `[sp-injector] 上游/映射 : ${cfg.getUpstreams().length} 个上游 / ${cfg.getModelMappings().length} 条映射`,
  );
  console.log(`[sp-injector] 上善若水 · 道法自然`);
  return { proxyServer, panelServer, ports: { proxy: proxyPort, panel: panelPort } };
}

// 直跑模式（node proxy.js）：自启动 + 优雅退出；被 require 时不自动监听
if (require.main === module) {
  startProxy().catch(() => process.exit(1));
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
}

module.exports = { startProxy };
