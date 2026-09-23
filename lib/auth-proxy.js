// lib/auth-proxy.js · 上游 HTTPS 转发 · 上善若水善利万物而有静
// 支持任意 Claude 协议后端：自定义 host/port/pathPrefix
// 出站代理可选：auto(继承系统代理) / direct(直连)

const http = require("http");
const https = require("https");
const net = require("net");
const { URL } = require("url");

// 从环境变量解析系统代理 URL
function _detectSystemProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  );
}

// 通过 HTTP 代理 CONNECT 隧道，建立到目标 host:port 的 TCP 流
function _connectViaProxy(proxyUrl, host, port, callback) {
  let purl;
  try {
    purl = new URL(proxyUrl);
  } catch (e) {
    return callback(new Error("bad proxy url: " + proxyUrl));
  }
  const proxyHost = purl.hostname;
  const proxyPort = parseInt(purl.port || "8080", 10);
  const target = `${host}:${port}`;

  const req = http.request({
    host: proxyHost,
    port: proxyPort,
    method: "CONNECT",
    path: target,
    headers: { Host: target },
  });
  req.setTimeout(15000, () => {
    req.destroy(new Error("proxy CONNECT timeout"));
  });
  req.on("connect", (res, socket) => {
    if (res.statusCode !== 200) {
      callback(new Error(`proxy CONNECT failed: ${res.statusCode}`));
      return;
    }
    callback(null, socket);
  });
  req.on("error", callback);
  req.end();
}

// 主转发函数（支持故障转移）：
//   req        : 原始 client 请求
//   body       : 改写后的请求体 Buffer
//   clientRes  : 原始 client 响应对象
//   candidates : [{upstream, apiKey, targetModel?}, ...] 有序候选列表
//                targetModel 有值时，该候选转发前把请求体 model 改写成它
//   onRelay    : (upstreamRes, wonCandidate) => void  拿到可用响应（2xx/3xx）时回调
//                wonCandidate 为胜出的候选 {upstream, apiKey, targetModel}，供统计埋点用
function forward(req, body, clientRes, candidates, onRelay) {
  if (!candidates || !candidates.length) {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "no upstream candidates" }));
    }
    return;
  }

  // 判断状态码是否该 fallback（连接失败 / 401/403/429/5xx）
  const shouldFallbackStatus = (code) => {
    if (code === 401 || code === 403 || code === 429) return true;
    if (code >= 500 && code < 600) return true;
    return false;
  };

  let idx = 0;
  const tryNext = () => {
    if (idx >= candidates.length) {
      // 全部候选都失败
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(
          JSON.stringify({
            error: "all upstream candidates failed",
            tried: candidates.length,
          }),
        );
      } else {
        try { clientRes.end(); } catch {}
      }
      return;
    }
    const { upstream, apiKey, targetModel } = candidates[idx];
    idx++;
    _tryOne(req, body, upstream, apiKey, targetModel || "", clientRes, (upstreamRes) => {
      // 拿到响应头：判断是否该 fallback
      if (shouldFallbackStatus(upstreamRes.statusCode)) {
        console.error(
          `[forward] candidate ${idx}/${candidates.length} (${upstream.host}) returned ${upstreamRes.statusCode}, fallback...`,
        );
        // 消耗掉这个响应 body（防止连接泄漏），然后试下一个
        upstreamRes.resume();
        upstreamRes.on("end", tryNext);
        upstreamRes.on("error", tryNext);
        return;
      }
      // 可用：交给上层 relay（带出胜出候选，供统计埋点）
      onRelay(upstreamRes, candidates[idx - 1]);
    }, tryNext); // 连接错误回调 → 试下一个
  };
  tryNext();
}

// 按候选的 targetModel 改写请求体 model（若有值且与当前不同）
// 返回新的 Buffer；targetModel 为空或 body 不可解析时原样返回
function _applyTargetModel(body, targetModel) {
  if (!targetModel) return body;
  try {
    const obj = JSON.parse(body.toString("utf8"));
    if (obj && obj.model !== targetModel) {
      obj.model = targetModel;
      return Buffer.from(JSON.stringify(obj), "utf8");
    }
  } catch {}
  return body;
}

// 单个候选尝试
function _tryOne(req, body, upstream, apiKey, targetModel, clientRes, onOk, onConnErr) {
  const host = upstream.host;
  const port = upstream.port;
  const pathPrefix = upstream.pathPrefix || "";
  const finalPath = pathPrefix + (req.url || "/");

  // 模型映射：每个候选按自己的 targetModel 改写请求体
  const outBody = _applyTargetModel(body, targetModel);

  const headers = { ...req.headers };
  headers["host"] = host;
  headers["content-length"] = String(Buffer.byteLength(outBody));
  if (apiKey) {
    headers["authorization"] = "Bearer " + apiKey;
    headers["x-api-key"] = apiKey;
  }

  let proxyUrl = "";
  if (upstream.useProxy === "auto") {
    proxyUrl = _detectSystemProxy();
  }

  const tryDirect = (socket) => {
    const opts = {
      host,
      port,
      method: req.method,
      path: finalPath,
      headers,
    };
    // servername（SNI）仅对域名有意义；host 是纯 IP 时不能设（Node 会抛 ERR_INVALID_ARG_VALUE）
    if (host && !net.isIP(host)) opts.servername = host;
    if (socket) {
      opts.socket = socket;
      opts.createConnection = () => socket;
    }
    const upstreamReq = https.request(opts, (upstreamRes) => {
      onOk(upstreamRes);
    });
    upstreamReq.setTimeout(120000, () => {
      upstreamReq.destroy(new Error("upstream timeout"));
    });
    upstreamReq.on("error", (e) => {
      console.error(`[forward] candidate (${host}) conn error: ${e.message}`);
      onConnErr(e);
    });
    upstreamReq.write(outBody);
    upstreamReq.end();
  };

  if (proxyUrl) {
    _connectViaProxy(proxyUrl, host, port, (err, socket) => {
      if (err) {
        console.error(
          `[forward] proxy CONNECT failed (${err.message}), try direct`,
        );
        tryDirect(null);
      } else {
        tryDirect(socket);
      }
    });
  } else {
    tryDirect(null);
  }
}

// 拉取上游支持的模型列表（OpenAI 兼容 GET 端点）
//   upstream: {host, port, pathPrefix, useProxy, modelsPath, apiKey}
//   返回 Promise<{models:[{name,contextK}], raw}>；失败 reject(Error)
// 路径策略：用 pathPrefix + modelsPath（modelsPath 默认 /models）；
//           若该路径 404 且 pathPrefix 不以 /v1 结尾，回退试 pathPrefix + /v1/models
function fetchModels(upstream) {
  const host = upstream.host;
  const port = upstream.port || 443;
  const pathPrefix = upstream.pathPrefix || "";
  const modelsPath = upstream.modelsPath || "/models";
  const apiKey = upstream.apiKey || "";

  let proxyUrl = "";
  if (upstream.useProxy === "auto") {
    proxyUrl = _detectSystemProxy();
  }

  // 对单个候选路径发 GET，返回 {status, body} 或抛错
  const tryPath = (p) =>
    new Promise((resolve, reject) => {
      const headers = { host };
      if (apiKey) {
        headers["authorization"] = "Bearer " + apiKey;
        headers["x-api-key"] = apiKey;
      }
      const doRequest = (socket) => {
        const opts = { host, port, method: "GET", path: p, headers };
        if (host && !net.isIP(host)) opts.servername = host;
        if (socket) {
          opts.socket = socket;
          opts.createConnection = () => socket;
        }
        const r = https.request(opts, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
          );
        });
        r.setTimeout(15000, () => r.destroy(new Error("fetch-models timeout")));
        r.on("error", reject);
        r.end();
      };
      if (proxyUrl) {
        _connectViaProxy(proxyUrl, host, port, (err, socket) => {
          if (err) doRequest(null); // 代理失败回退直连
          else doRequest(socket);
        });
      } else {
        doRequest(null);
      }
    });

  // 解析 OpenAI 风格 {data:[{id,...}]} 响应
  const parseModels = (body) => {
    const obj = JSON.parse(body);
    const arr = Array.isArray(obj && obj.data) ? obj.data : [];
    return arr.map((m) => ({ name: m.id || m.name || "", contextK: m.contextK || m.context_length || null })).filter((m) => m.name);
  };

  return tryPath(pathPrefix + modelsPath)
    .then((res) => {
      // 仅当用的是默认 /models 且 404 时，回退试 /v1/models（针对 pathPrefix 不含 /v1 的上游）
      if (res.status === 404 && modelsPath === "/models" && !pathPrefix.endsWith("/v1")) {
        return tryPath(pathPrefix + "/v1/models");
      }
      return res;
    })
    .then((res) => {
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`upstream returned ${res.status}: ${res.body.slice(0, 200)}`);
      }
      let models;
      try {
        models = parseModels(res.body);
      } catch (e) {
        throw new Error(`无法解析模型列表响应: ${e.message}`);
      }
      return { models, raw: res.body };
    });
}

module.exports = {
  forward,
  fetchModels,
  detectSystemProxy: _detectSystemProxy,
};
