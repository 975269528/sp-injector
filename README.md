# sp-injector · 道法自然

> 本地透明代理 + PC 桌面客户端:拦截 LLM 客户端(Anthropic / OpenAI / Responses 协议)发出的请求,把 `system` 字段**替换 / 前置 / 按章节保留**为可切换的模板(道德经 / 阴符经 / 自定义),按模型映射路由到任意上游,流式响应原样透传,并用统计面板记录用量。
>
> 核心理念:**经文即一切**——用文本模板替代官方系统提示词。本工具**只改请求、不改响应**,轻、稳、通用。

## ✨ 特性

- **Electron 桌面客户端**:双击即用,窗口 + 系统托盘常驻,关窗口不退出;也支持 `node proxy.js` 命令行直跑。
- **多协议注入**:Anthropic(`system` 字段)、OpenAI(`messages[].role=system`)、Responses(`instructions`)三种格式,按模式改写——`replace`(替换)/ `prepend`(前置)/ `keepSections`(经文+勾选保留的官方章节)/ `official`(不改,仅观测)。
- **上游池 + 模型映射**:客户端 model 名精确映射到「上游 + 真实模型名」,多候选按序故障转移;`GET /v1/models` 自动下发可用模型列表(OpenAI 兼容)。
- **使用统计**:按天/区间统计请求、token(输入/输出/缓存)、TTFB/P95、失败率;调用流水逐条可查(5000 条);模型维度汇总与趋势图。
- **System 抓取**:记录每条请求的原始与改写后 system 全文,可对比、可复制。
- **模板管理**:纯文本存储,多选按序拼接,面板即改即生效。
- **零运行时依赖**:核心逻辑纯 Node 原生模块;Electron 仅开发/打包期依赖。

## 📦 这是什么 / 不是什么

**是**:一个能改写 AI 请求 system prompt 的本地中间层,给模型注入任意"开场白指令"(道家经文、角色设定、写作规范等),顺带做模型路由与用量观测。

**不是**:绕过模型内容安全限制的工具。模型的安全行为来自训练权重,不在 system prompt 层。

## 🚀 快速开始

### 桌面客户端(推荐)

```bash
npm install        # 首次:安装 electron(开发依赖)
npm run dev        # 启动桌面客户端
```

- 窗口即管理面板;关闭窗口 = 最小化到托盘(代理常驻),托盘菜单可「显示面板 / 复制代理地址 / 退出」。
- 数据(模板/上游/统计)存于系统用户目录:
  - Windows:`%APPDATA%/sp-injector/`(首次启动自动从项目 `state/`、`templates/` 迁移)
  - 日志:`%APPDATA%/sp-injector/logs/app.log`
- 代理默认 `http://127.0.0.1:8080`,被占用时自动换端口(顶栏地址实时显示)。

### 命令行直跑(开发/服务器)

```bash
node proxy.js      # 前台跑,数据在项目目录 state/ templates/
```

### 打包安装程序

```bash
npm run dist       # 输出 dist/sp-injector-setup-<版本>.exe 与 portable 版
```

### 客户端接入

把客户端(ZCode / Cherry Studio / ChatBox 等)的 API 地址指向代理:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080   # Anthropic 协议
# 或 OpenAI 兼容客户端直接填 http://127.0.0.1:8080,模型列表自动获取
```

然后在面板「路由」页配置上游池(域名/端口/Key/模型列表)与模型映射,「模板」页勾选要注入的模板,「注入」页选模式。

## 📁 目录结构

```
sp-injector/
├── electron/         # 桌面壳(main.js 生命周期/托盘/迁移 · preload.js 端口注入 · icon.png)
├── proxy.js          # 核心:双端口服务(8080 代理 + 8088 面板)+ 全部面板 API
├── lib/              # config(状态持久化/路由匹配) · templates · capture · modelStats
│                     # usageLog(流水) · tokenScan(流式 usage 采样) · sectionParser · auth-proxy
├── panel/            # Web 面板(原生 HTML/CSS/JS,无框架,浅色极简)
│   ├── index.html    # 单页 7 视图:概览/使用记录/模板/注入/路由/抓取/设置
│   ├── panel.css     # 设计 token 体系
│   ├── icons.js      # 内联 SVG 图标库
│   └── views/        # 各视图渲染逻辑
├── templates/        # 内置注入模板(帛书老子/阴符经/自定义)· 桌面版种子来源
├── scripts/          # gen-icon.js(生成应用图标)+ node 直跑辅助脚本
├── state/            # 命令行模式的数据目录(桌面版用 userData)
└── docs/             # 设计文档
```

## ⚙️ 配置

环境变量(命令行模式;桌面模式端口自动管理):

| 变量 | 默认 | 说明 |
|---|---|---|
| `SP_PROXY_PORT` | `8080` | 代理入口端口(占用自动 +1) |
| `SP_PANEL_PORT` | `8088` | 面板端口(占用自动 +1) |
| `SP_DATA_DIR` | 项目根 | 数据目录(桌面版由 Electron 注入 userData) |
| `HTTPS_PROXY` / `HTTP_PROXY` | (无) | 出站系统代理,`useProxy: auto` 的上游自动继承 |

## 🔒 安全说明

- 端口只绑 `127.0.0.1`,外部网络无法访问。
- 面板不落盘 API key 之外的敏感内容;抓取只记录 system 原文,不记用户消息。
- 流水与统计保留上限(流水 5000 条),可随时在面板清空。

## 🧪 验证是否生效

1. 访问 `http://127.0.0.1:8080/__health`,应返回 JSON 状态。
2. 面板「System 抓取」应出现记录,如 `system 15→7839 字`。
3. 面板「概览」的请求/token 统计与趋势图应开始增长。

## 📐 工作原理

```
客户端 ──POST /chat/completions──► [代理 :8080]
                                     │ 1. model 精确匹配映射 → 候选上游链
                                     │ 2. 解析原始 system(按协议格式)
                                     │ 3. 按模式改写:replace/prepend/keepSections/official
                                     │ 4. targetModel 改写请求体 · 注入该上游 apiKey
                                     │ 5. 抓取原始/改写 system 入环形缓冲
                                     └──► [上游(多候选故障转移)]
                                               │ 响应(含SSE)原样 pipe 回客户端
                                               └ 只读旁路采样 usage → 流水/统计
```

响应阶段**零修改**:不解析、不缓冲、不改动,保证流式体验与直连完全一致;token 用量从流中"尽力"采样,不影响转发。

---

> 损之又损,以至于无为 · 无为而无不为 · **道法自然**。
