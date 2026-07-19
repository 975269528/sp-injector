# sp-injector · 道法自然

> 本地透明代理：拦截 ZCode（及任何走 Anthropic Messages API 的客户端）发出的请求，把 `system` 字段**就地替换/前置**为可切换的模板（道德经 / 阴符经 / 自定义），流式响应原样透传。含 Web 面板管理模板与查看日志。
>
> 核心理念借鉴 [kiro-assistant](https://github.com/zhouyoukang1234-spec/kiro-assistant)：**经文即一切**——用文本模板替代官方系统提示词。但本工具**只改请求、不改响应**，更轻、更稳、更通用。

## ✨ 特性

- **透明代理**：本机 HTTP 代理拦截 `POST /v1/messages`，就地改写 `system`。
- **两种注入模式**：
  - `replace`（默认）：原 system 整体丢弃，换成模板。
  - `prepend`：模板放前面，原 system 保留在后面。
- **模板管理**：纯文本文件存储（`templates/*.txt`），Web 面板可增删改查 + 一键激活。
- **预设经文**：帛书《老子》（德经+道经）、道藏《阴符经》三章，开箱即用。
- **流式透传**：响应（含 SSE 流）一字不改直接 pipe 回客户端，零延迟、零缓冲。
- **VPN 友好**：自动继承系统代理（`HTTPS_PROXY`/`HTTP_PROXY`），失败回退直连。
- **零依赖**：纯 Node.js 原生模块，无需 `npm install`。
- **Web 面板**：实时日志、改写前后 system 对比、注入统计、模式切换。

## 📦 这是什么 / 不是什么

**是**：一个能改写 AI 请求 system prompt 的本地中间层，让你可以给模型注入任意"开场白指令"（道家经文、角色设定、写作规范等）。

**不是**：绕过模型内容安全限制的工具。模型的安全行为来自训练权重，不在 system prompt 层，改 prompt 改不动它。

## 🚀 快速开始

### 1. 启动代理

```bash
# 方式一：bash（Git Bash / WSL / macOS / Linux）
./scripts/start.sh

# 方式二：Windows cmd
scripts\start.cmd

# 方式三：前台跑（看实时日志）
node proxy.js
```

启动后：
- **Web 面板**：http://127.0.0.1:8088
- **代理入口**：http://127.0.0.1:8080

### 2. 把 ZCode / Claude 客户端指向代理

设置环境变量，让客户端的请求先经过代理：

```bash
# bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080

# Windows cmd
set ANTHROPIC_BASE_URL=http://127.0.0.1:8080

# Windows PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
```

然后正常启动 ZCode / Claude 客户端即可。每个请求的 system 会被自动替换为当前模板。

### 3. 在面板里管理模板

打开 http://127.0.0.1:8088 ：
- 左侧列表选模板 → 中间编辑器改内容 → 保存 → 点"设为当前"激活。
- 右侧切换注入模式（替换/前置）、开关 `# Scripture` 头、查看实时日志。
- 日志可展开看每次请求的原始 system 与改写后 system 对比。

### 4. 停止

```bash
./scripts/stop.sh      # bash
scripts\stop.cmd       # cmd
```

## 📁 目录结构

```
sp-injector/
├── proxy.js          # 代理主体（双端口：8080 代理 + 8088 面板）
├── panel/            # Web 面板（原生 HTML/CSS/JS，无框架）
├── templates/        # 注入模板（纯文本 .txt）
│   ├── laozi.txt        # 帛书老子（德经+道经，7204 字）
│   ├── yinfu.txt        # 道藏阴符经（599 字）
│   └── custom.txt       # 自定义空模板
├── lib/
│   ├── config.js     # 配置 + 状态持久化
│   ├── templates.js  # 模板 CRUD
│   ├── logger.js     # 环形缓冲日志（最近 200 条）
│   └── auth-proxy.js # 上游 HTTPS 转发（继承系统代理）
├── scripts/          # start / stop / status（.cmd + .sh）
├── state/            # 运行时状态（PID、当前模板、模式）· gitignore
└── docs/             # 设计文档
```

## ⚙️ 配置

可通过环境变量覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SP_PROXY_PORT` | `8080` | 代理入口端口 |
| `SP_PANEL_PORT` | `8088` | Web 面板端口 |
| `SP_UPSTREAM_HOST` | `api.anthropic.com` | 上游后端 |
| `HTTPS_PROXY` / `HTTP_PROXY` | （无） | 系统代理，代理转发时自动继承 |

## 🔒 安全说明

- 两个端口均**只绑 127.0.0.1**，外部网络无法访问。
- 代理**不存储、不打印 API key**——`Authorization`/`x-api-key` 头原样透传，不读不记。
- 日志只记 system 的**长度 + 前 200 字预览**，不记录用户消息内容。
- 模板名严格校验（`^[a-zA-Z0-9_-]+$`），防路径穿越。

## 🧪 验证是否生效

1. 启动后访问 http://127.0.0.1:8080/__health ，应返回 JSON 状态。
2. 面板"请求日志"区应出现注入记录，展开能看到 `system 28→7233 字` 这类改写。
3. 实际发一条对话，AI 的回复风格应受当前模板影响。

## 📐 工作原理

```
ZCode ──POST /v1/messages──► [代理 :8080]
                                │ 1. 读 body → JSON.parse
                                │ 2. 取 obj.system
                                │ 3. 按模式: replace→换模板 / prepend→模板+原system
                                │ 4. 重算 Content-Length
                                │ 5. 透传所有 header
                                └──► [api.anthropic.com:443]
                                          │
                                          └──响应(含SSE流)原样 pipe 回 ZCode
```

响应阶段**零处理**：不解析、不缓冲、不修改，保证流式体验与直连完全一致。

---

> 损之又损，以至于无为 · 无为而无不为 · **道法自然**。
