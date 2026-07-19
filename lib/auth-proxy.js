// lib/auth-proxy.js · 上游 HTTPS 转发 · 上善若水善利万物而有静
// 支持任意 Claude 协议后端：自定义 host/port/pathPrefix
// 出站代理可选：auto(继承系统代理) / direct(直连) / custom(指定 URL)

const http = require("http");
const https = require("https");
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
//   candidates : [{upstream, apiKey}, ...] 有序候选列表
//   onRelay    : (upstreamRes) => void  拿到可用响应（2xx/3xx）时回调
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
    const { upstream, apiKey } = candidates[idx];
    idx++;
    _tryOne(req, body, upstream, apiKey, clientRes, (upstreamRes) => {
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
      // 可用：交给上层 relay
      onRelay(upstreamRes);
    }, tryNext); // 连接错误回调 → 试下一个
  };
  tryNext();
}

// 单个候选尝试
function _tryOne(req, body, upstream, apiKey, clientRes, onOk, onConnErr) {
  const host = upstream.host;
  const port = upstream.port;
  const pathPrefix = upstream.pathPrefix || "";
  const finalPath = pathPrefix + (req.url || "/");

  const headers = { ...req.headers };
  headers["host"] = host;
  headers["content-length"] = String(Buffer.byteLength(body));
  if (apiKey) {
    headers["authorization"] = "Bearer " + apiKey;
    headers["x-api-key"] = apiKey;
  }

  let proxyUrl = "";
  if (upstream.useProxy === "auto") {
    proxyUrl = _detectSystemProxy();
  } else if (upstream.useProxy === "custom" && upstream.customProxyUrl) {
    proxyUrl = upstream.customProxyUrl;
  }

  const tryDirect = (socket) => {
    const opts = {
      host,
      port,
      method: req.method,
      path: finalPath,
      headers,
      servername: host,
    };
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
    upstreamReq.write(body);
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

module.exports = {
  forward,
  detectSystemProxy: _detectSystemProxy,
};
