# sp-injector 界面重构 + System 抓取 设计文档

> 将面板从单页编辑器重构为管理后台风格（左栏 + 顶导），新增 System 抓取功能，抓取并展示所有经过代理请求的原始 system 原文。

## 一、目标与边界

### 目标
1. 界面重构为**管理后台风格**：顶部导航 + 左侧栏 + 主区视图切换。
2. 新增 **System 抓取**：抓取所有经过代理请求的原始 system 原文，提供列表查看、详情对比、清空。
3. 五个视图：概览 / 模板 / 上游 / System 抓取 / 设置。

### 非目标（明确不做）
- 不做登录/鉴权（端口仅绑 127.0.0.1）。
- 不做 token 仪表盘（用户已取消）。
- 不做响应解析（保持响应原样透传，只在请求侧抓 system）。
- 不做数据持久化（抓取存内存，重启清空）。

## 二、整体架构

### 后台布局
```
顶部导航（高 48px，固定）
├── 左侧栏（宽 180px，固定）: 5 个导航项
└── 主区（flex:1，可滚动）: 当前视图内容
底部状态条（可选，最小化）
```

### 顶部导航条
- 左侧：logo + 名称 "sp-injector"
- 中间：代理地址 + 复制按钮（紧凑内联）
- 右侧：运行状态指示灯（绿点 = 运行）

### 左侧栏五个视图
| 视图 | 内容 |
|---|---|
| 概览 | 顶部状态摘要 + 4 个统计卡（总请求/已注入/透传/官方）+ system 抓取计数 |
| 模板 | 现有模板列表（多选）+ 编辑器，迁移 |
| 上游 | 现有上游配置 + 接口格式 + 注入模式 + Scripture 头，迁移 |
| System 抓取 | 新增：抓取列表 + 详情对比 |
| 设置 | 启动/停止说明、端口、关于（最小化） |

## 三、前端文件拆分

零 npm 依赖、零构建工具。多文件 + 全局对象 `window.spApp`，用 `<script>` 顺序加载。

```
panel/
├── index.html        # 主框架：顶部导航 + 左侧栏 + 各视图容器
├── panel.css         # 全局样式 + 后台布局
├── app.js            # 入口：路由切换、初始化、全局状态
├── api.js            # API 封装（fetch 包装）
├── views/
│   ├── overview.js   # 概览视图
│   ├── templates.js  # 模板视图（迁移现有模板/编辑器逻辑）
│   ├── upstream.js   # 上游视图（迁移现有上游/格式/模式逻辑）
│   └── captures.js   # System 抓取视图（新增）
└── components/
    ├── addr-bar.js   # 顶部代理地址条
    └── status-bar.js # 底部状态条
```

各文件挂到全局对象 `window.spApp` 上。加载顺序：api.js → app.js → components → views。

## 四、System 抓取（核心新增）

### 4.1 抓取逻辑（proxy.js 改造）
每个被处理的请求（包括 official 模式原样转发的），在改写前抓取**原始 system**，存进内存环形缓冲。

改动点：在现有 `getOrigSystem(obj)` 取到 originalSystem 后，额外调用 `capture.push(...)`。零额外解析开销（system 本来就要读出来判断注入）。

### 4.2 抓取字段（每条记录）
```
{
  seq,             // 序号（自增）
  ts,              // 时间戳
  format,          // anthropic/openai/responses
  path,            // 请求路径
  model,           // 模型名（从 body.model 取）
  mode,            // 注入模式（replace/prepend/official）
  activeTemplates, // 激活模板列表（快照）
  originalSystem,  // 原始 system 全文（改写前）
  originalLen,     // 原始长度
  injectedSystem,  // 改写后 system（截断前 2000 字，便于对比）
  injectedLen,     // 改写后长度
}
```

### 4.3 抓取范围与隐私
- 抓**所有格式**的 system（anthropic 的 system / openai 的 messages[0] / responses 的 instructions）。
- **official 模式也抓**（最有价值：能看到未注入的官方原文）。
- 环形缓冲 **200 条**，重启清空。
- **不记录** user message、API key、请求 header（隐私）。

### 4.4 lib/capture.js（新模块）
- `push(entry)` — 追加，超 200 条删最旧
- `list()` — 返回轻量列表（不含 system 全文：只 seq/ts/model/format/originalLen/injectedLen/mode/templates）
- `get(seq)` — 返回单条详情（含全文）
- `clear()` — 清空
- `stats()` — 返回 {total, buffered}

### 4.5 面板 API（panelServer 新增）
- `GET /api/captures` → 轻量列表
- `GET /api/captures/:seq` → 单条详情
- `POST /api/captures/clear` → 清空

## 五、System 抓取视图 UI

```
┌──────────────────────────────────────────────────────────┐
│ System 抓取                              [刷新] [清空]    │
│ 共 N 条 · 注入 M 条 · 官方 K 条                           │
├──────┬───────────┬───────┬────────┬────────┬─────────────┤
│ #   │ 时间       │ 模型  │ 格式   │ 原始长 │ 模式/模板    │
├──────┼───────────┼───────┼────────┼────────┼─────────────┤
│ 12  │ 14:23:01  │GLM-5.2│anthropic│ 46158 │ replace+道..│ ← 点开
│ 11  │ 14:22:50  │GLM-5.2│anthropic│ 28    │ official    │
└──────┴───────────┴───────┴────────┴────────┴─────────────┘
点某行 → 下方展开详情面板（原始 system vs 改写后，左右对比或上下）
```

- 列表按 seq 倒序（最新在前）。
- 模式标记：replace/prepend 蓝色，official 灰色。
- 详情面板：原始 system 与改写后 system 上下或左右对比，可滚动，支持选中复制。
- 支持复制单条 system 全文。

## 六、数据流与轮询

### 全局状态（spApp.state）
```
{
  format, mode, activeTemplates, useHeader,
  upstream, effective_proxy, stats,
}
```
启动时加载一次，之后后台轮询刷新。

### 刷新策略（避免请求风暴）
| 数据 | 触发方式 | 频率 |
|---|---|---|
| 全局状态 /api/state | 后台轮询 | 每 8 秒 |
| 抓取列表 /api/captures | 进入抓取视图时拉 + 轮询 | 每 5 秒（仅在该视图激活时） |
| 单条详情 /api/captures/:seq | 点击行 | 按需 |
| 模板列表/内容 | 操作后刷新 | 按需 |

### 视图切换机制
```js
spApp.navigate(viewName)
// 1. 切换左栏高亮
// 2. 显示对应 view 容器，隐藏其它
// 3. 调用 onEnter() / onLeave()
```
每个视图对象实现两个钩子：
- `onEnter()` — 进入时拉数据、启动该视图专属轮询
- `onLeave()` — 离开时停轮询

## 七、现有功能迁移

### 模板视图（从现有 panel.js 迁移）
- 多选勾选 + 序号徽章
- 编辑器（编辑/保存/新建/删除/重新加载）
- "勾选注入"按钮
- 焦点态 vs 激活态区分

### 上游视图（从现有 panel.js 迁移）
- 接口格式三选（Anthropic/OpenAI/Responses）
- 注入模式三选（替换/前置/官方）
- Scripture 头开关
- 上游 API 配置（host/port/pathPrefix/useProxy/customProxyUrl）
- 出站代理下拉联动

### 状态条（底部，最小化）
- 顶部地址条已有代理地址，底部状态条放：模式/格式/模板/上游/网络 的 badge 摘要。

## 八、样式规范

沿用现有暗色主题（深色背景 #0f1115 + 蓝色 accent #6ab0f3）。
- 后台布局用 CSS Grid / Flexbox。
- 左栏导航项：hover 高亮、active 蓝色左边框。
- 统计卡：网格布局，大数字 + 标签。
- 表格：斑马纹、行 hover、点击展开。
- 保持紧凑，避免大面积留白。

## 九、错误处理

- API 失败：视图内显示错误提示，不阻塞其它视图。
- 抓取 buffer 满：自动淘汰最旧，无报错。
- 视图切换失败：回退到概览视图 + 提示。
- 静态文件加载失败：panelServer 返回 404 JSON。

## 十、测试

手动冒烟（无自动化）：
1. 启动代理，面板五个视图切换正常，左栏高亮跟随。
2. 发请求，概览统计卡数字增长。
3. System 抓取视图出现记录，点开能看到原始/改写后 system 对比。
4. official 模式下请求，抓取列表标记 official 且 originalSystem 完整。
5. 切换接口格式，对应格式请求都能被抓取。
6. 清空抓取，列表清零。
