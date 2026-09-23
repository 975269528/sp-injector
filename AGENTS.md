# sp-injector 项目规则

> 所有会话/代理在本仓库工作前必读。第一优先级:**绝不泄露上游 API key**。

## 一、API Key 安全铁律

1. **key 只允许存在于两处**,别处一律禁止:
   - 仓库 `state/upstreams.json`(直跑模式,`node proxy.js`)
   - `%APPDATA%/sp-injector/state/upstreams.json`(Electron 打包版)
   前者被 `.gitignore` 的 `state/` 规则拦截,后者在仓库外,git 天然不可见。
2. **永远不要**:
   - 把 key 硬编码进任何源码、脚本、文档、示例、测试、注释
   - `git add -f state/` 或以任何方式绕过 .gitignore 提交 state/ 内容
   - 删除或修改 `.gitignore` 中的 `state/`、`dist/`、`.mimosa/` 规则
   - 在日志(`state/*.log`)、面板接口响应、错误信息、README 中输出完整 key
3. **每次提交前**必须对暂存区跑下方的安全扫描,零命中才允许提交:
   ```bash
   git grep --cached -nE "sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\"apiKey\"[ ]*:[ ]*\"[^\"]{16,}\"" -- . ':(exclude)package-lock.json'
   ```
4. 新增运行时数据/缓存文件一律放 `state/` 下,不放仓库根目录。
5. **事故响应**:若 key 意外进入 git(无论是否已推送),立即停手告知用户;先到各上游服务商处轮换 key,再清理/重写历史。绝不静默处理。

## 二、提交与推送规范

- 中文 conventional commits,格式 `type(scope): 描述`,参考 `git log` 既有风格。
- 提交作者邮箱保持 GitHub noreply(仓库级 `user.email` 已配好),不要改回真实邮箱。
- 提交会经过 Mimosa 预提交钩子扫描;已知误报见下节,误报时做最小改动绕开,不要去"修复"不存在的漏洞。
- 推送前确认:`git status` 干净且上方安全扫描零命中。远程是**私有**仓库;转公开前必须经用户确认并复核全部历史提交。

## 三、Mimosa 钩子已知误报(本项目实证)

- `.query(` 命名且参数含用户输入 → 误判 SQL 注入:函数改名 `list`/`browse`。
- `path.join(X, 常量标识符)` → 误判路径穿越并拦截 commit:把常量内联为字面量。

## 四、结构与验证

- 入口 `proxy.js`(双 server:8080 代理 / 8088 面板);`lib/` 核心模块;`panel/` 面板前端;`electron/` 桌面壳;`templates/` 内置经文模板(禁止删除,中文文件名是特性)。
- 改动 `lib/` 后冒烟:`node -e "require('./lib/xxx')"`。
- 数据目录由 `SP_DATA_DIR` 决定(见 `lib/config.js`):打包版注入 userData,直跑为仓库根。
- shell 是 Git Bash:丢弃输出用 `/dev/null`,绝不用 `nul`(会生成 Windows 保留名空文件)。
