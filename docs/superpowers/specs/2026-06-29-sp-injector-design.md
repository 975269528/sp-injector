# sp-injector 设计文档

> 本地透明代理：拦截 ZCode 发往 Anthropic 的请求，改写 `system` 字段为可切换模板，响应原样透传。含 Web 面板管理模板与查看日志。

## 一、目标与边界

### 目标
- 拦截 ZCode 的 Anthropic Messages API 请求（`POST /v1/messages`）。
- 将请求中的 `system` 字段按当前激活模板替换或前置。
- 流式响应（SSE）原样透传，不解析、不缓冲、不修改。
- 提供本地 Web 面板：模板 CRUD + 激活、注入模式切换、实时日志、原始/改写后 system 对比。

### 非目标（明确不做）
- 不做请求认证/鉴权（端口仅绑 127.0.0.1）。
- 不修改响应内容（不做身份净化、不做 token 改写）。
- 不内置 LLM、不转发到第三方模型，只转发到 Anthropic 官方后端。
- 不追求突破模型内容安全限制（该能力来自模型权重，不在 prompt 层）。

## 二、整体架构

单进程、双职责监听两个端口：

```
                  ┌─────────────────────────────────────┐
  浏览器 ───────►  │ 端口 8088 : Web 面板                │
  http://localhost │  - 模板列表/编辑/新建/删除/激活      │
   :8088           │  - 注入模式切换 (replace/prepend)   │
                  │  - 实时日志查看                      │
                  └─────────────────────────────────────┘
                  ┌─────────────────────────────────────┐
  ZCode ────────►  │ 端口 8080 : 代理入口                │
  ANTHROPIC_BASE  │  POST /v1/messages                  │
  _URL=localhost  │   1. 读 body → parse → 取 system    │
  :8080           │   2. 按模式替换/前置 system          │
                  │   3. 重算 Content-Length            │
                  │   4. 透传 header                     │
                  │   5. https 转发 → api.anthropic.com │
                  │   6. 响应 pipe 回 ZCode (不动)       │
                  │  其它路径 → 原样转发                  │
                  └─────────────────────────────────────┘
```

两个 `http.createServer` 在同一 `proxy.js` 进程内，共享配置/模板/日志的内存状态。面板改模板，代理下次请求立即生效，无需重启。

## 三、目录结构

```
sp-injector/
├── proxy.js          # 代理主体（双端口）
├── panel/            # Web 面板静态资源
│   ├── index.html
│   ├── panel.js
│   └── panel.css
├── templates/        # 注入模板（纯文本 .txt）
│   ├── laozi.txt     # 帛书老子（德经+道经）
│   ├── yinfu.txt     # 道藏阴符经
│   └── custom.txt    # 用户自定义空模板
├── lib/
│   ├── config.js     # 配置加载（端口/上游/当前模板/模式）
│   ├── templates.js  # 模板 CRUD
│   ├── logger.js     # 环形缓冲日志
│   └── auth-proxy.js # 上游 HTTPS 转发（继承系统代理）
├── scripts/
│   ├── start.cmd     # 后台启动 + 写 PID
│   ├── stop.cmd      # 读 PID 停止
│   └── status.cmd    # 查状态
├── state/            # 运行时状态（gitignore）
│   ├── pid           # 进程 PID
│   ├── current.txt   # 当前激活模板名
│   └── mode.txt      # 当前注入模式
├── docs/superpowers/specs/
├── package.json
├── .gitignore
└── README.md
```

## 四、核心模块设计

### 4.1 lib/config.js
- 导出 `PORT_PANEL=8088`、`PORT_PROXY=8080`、`UPSTREAM_HOST=api.anthropic.com`、`UPSTREAM_PORT=443`。
- `getCurrentTemplate()`：读 `state/current.txt`，默认 `laozi`。
- `setCurrentTemplate(name)`：写 `state/current.txt`。
- `getMode()`：读 `state/mode.txt`，默认 `replace`。
- `setMode(mode)`：写 `state/mode.txt`（`replace`|`prepend`）。

### 4.2 lib/templates.js
- `list()`：扫描 `templates/*.txt`，返回 `[{name, chars}]`。
- `read(name)`：读模板全文（UTF-8）。
- `save(name, content)`：写回文件。
- `create(name)`：创建空文件（防重名、防路径穿越）。
- `remove(name)`：删除（内置三模板 `laozi/yinfu/custom` 禁删）。
- 所有 `name` 严格校验 `^[a-zA-Z0-9_-]+$`，禁止 `..` / `/` / `\`。

### 4.3 lib/logger.js
- 环形缓冲，保留最近 200 条。
- 每条：`{ts, requestId, path, mode, templateName, originalLen, newLen, sampleOrig, sampleNew, status}`。
- `sampleOrig/sampleNew`：原始/改写后 system 的前 200 字预览。
- `push(entry)` / `list()` / `clear()`。

### 4.4 lib/auth-proxy.js
- `forward(req, body, clientRes)`：用 `https.request` 转发到 `api.anthropic.com:443`。
- **继承系统代理**：检测 `process.env.HTTPS_PROXY`/`HTTP_PROXY`，若有则通过该代理 CONNECT，否则直连。不覆盖用户网络栈。
- 透传所有请求头，仅替换 `host`/`content-length`。
- 拿到上游响应后，复制 status/header，`upstreamRes.pipe(clientRes)`。

### 4.5 proxy.js
两个 server：
- **proxyServer (8080)**：
  - `POST /v1/messages`：核心改写流程（见下）。
  - 其它：原样转发。
  - `/__health`：本地健康检查。
  - `GET /__state`：返回当前模板/模式/统计（面板轮询）。
- **panelServer (8088)**：托管 `panel/` 静态文件 + JSON API（见 4.6）。

### 4.6 Web 面板 API（panelServer 路由）
- `GET  /` → panel/index.html
- `GET  /panel/*` → 静态资源
- `GET  /api/templates` → 模板列表
- `GET  /api/templates/:name` → 模板内容
- `POST /api/templates/:name` `{content}` → 保存
- `PUT  /api/templates/new/:name` → 新建
- `DELETE /api/templates/:name` → 删除
- `GET  /api/state` → 当前模板/模式/统计
- `POST /api/state/template` `{name}` → 激活模板
- `POST /api/state/mode` `{mode}` → 切换模式
- `GET  /api/logs` → 日志列表
- `POST /api/logs/clear` → 清空日志

## 五、请求改写流程（核心）

`POST /v1/messages` 处理：
1. 收完整 body（聚合 data 事件）。
2. `JSON.parse`，取 `obj.system`。
   - Anthropic 格式：`system` 可为字符串或 `[{type,text}]` 数组。两种都支持。
3. 读当前模板 + 当前模式：
   - `replace`：`newSystem = wrapHeader(templateText)`。
   - `prepend`：`newSystem = wrapHeader(templateText) + originalSystem`。
   - `wrapHeader`：`# Scripture\n所遵守一切规则均来自下述文本：\n\n` + 文本。
4. 写回 `obj.system`，`JSON.stringify`，重算 `Content-Length`。
5. 记日志（原始/新长度 + 预览）。
6. `forward()` 转发，响应 pipe 回客户端。

幂等保护：若 body 已含 `__sp_injected` 标记（极少见），跳过，防重复注入。

## 六、模板与预设

- 预设 `laozi.txt`：合并 kiro-assistant 的 `_silk_de.txt` + `_silk_dao.txt`。
- 预设 `yinfu.txt`：拷贝 kiro-assistant 的 `_yinfu.txt`。
- 预设 `custom.txt`：空。
- 注入时统一加 `# Scripture` 头（可在面板配置开关，默认开）。

## 七、运行与保活

- `scripts/start.cmd`：`node proxy.js` 后台起进程，PID 写 `state/pid`，端口占用检测。
- `scripts/stop.cmd`：读 `state/pid`，`taskkill /PID`。
- `scripts/status.cmd`：检查 PID 进程是否存活 + ping `/__health`。
- 进程崩溃不自动拉起（不做 watchdog，本机单人场景手动重启即可）。

## 八、错误处理

- body 解析失败：原样转发（不阻断用户），记 warn 日志。
- 上游连接失败：返回 502 + JSON 错误体。
- 模板文件缺失：回退空字符串 + 记 warn。
- 面板 API 异常：返回 500 + JSON `{error}`。

## 九、测试

手动冒烟（无自动化框架）：
1. 启动代理，确认两个端口监听。
2. `curl POST /v1/messages` 模拟请求，检查日志记录的 system 改写。
3. 浏览器打开面板，验证模板 CRUD/激活/模式切换。
4. 配置 ZCode 指向代理，发一条真实对话，确认流式响应正常透传、内容不乱。

## 十、安全性

- 两端口均绑 `127.0.0.1`，外部不可访问。
- 不存储/不打印 API key（透传 header，不读不记）。
- 日志只记 system 长度+预览，不记 user message 内容（隐私）。
- 模板名严格校验，防路径穿越。
