# chatlogwebUI AI Coding Instructions

请默认使用中文沟通；技术名词、命令、路径、配置、终端输出保持英文原样。回答要实战、冷静、直接；不确定就说明不确定，并给出验证方法。

## Project Overview

`chatlogwebUI` 是一个真实运行的 Web 应用，不是纯模板仓或内容仓。

- 业务目标：基于 Chatlog HTTP 服务查询微信聊天记录，并提供 AI 分析、定时分析配置、分析历史和报告查看。
- 自动化目标：仓库内同时保留 `.agents/`、`.claude/`、`.cursor/`、`scripts/ralph/`，用于把 PRD 拆成 user stories 并让开发/验证 agent 迭代。
- 默认本地地址：Web UI 在 `http://localhost:3000`，Chatlog HTTP 通常在 `http://127.0.0.1:5030`，但必须实时检查，不能假设在线。

## Stack And Runtime

- Runtime：Node.js 18+。
- Server：Express + EJS，主入口是 `server.js`。
- Frontend：vanilla JS + CSS，主页面是 `views/index.ejs`。
- Scheduler：`node-cron`，定时分析逻辑集中在 `server.js` 和 `test-scheduler.js`。
- Package manager：npm，当前没有独立 build/lint/test 脚本。
- AI providers：DeepSeek、Gemini、MiniMax。涉及价格、模型能力、API 行为、发布时间时必须核查来源，不要凭记忆写死。

## Common Commands

```bash
npm install
npm start
npm run dev
node --check server.js
node --check test-scheduler.js
node --check public/js/app.js
node --check public/js/ai-settings.js
node --check public/js/model-settings.js
curl -sS http://localhost:3000/api/status
curl -sS http://localhost:3000/api/model-settings
curl -sS http://localhost:3000/api/get-analysis-config
```

如果 `:3000` 已有可访问服务，优先复用，不要重复启动。这个环境里 `tmux` 比 `nohup` 更稳；需要保活时可用：

```bash
tmux new-session -d -s chatlogwebui -c /Volumes/WorkSSD/Dev/chatlogwebUI 'node server.js > /tmp/chatlogwebui.log 2>&1'
```

## Repository Structure

- `server.js` - Express 主入口、API 路由、Chatlog 集成、AI provider 调用、定时分析、配置读写。
- `views/index.ejs` - 主页面和 modal DOM；静态资源引用应带 `?v=<%= Date.now() %>`。
- `public/js/model-settings.js` - 模型设置前端逻辑。
- `public/js/ai-settings.js` - 分析项、动态分析配置和保存逻辑。
- `public/js/app.js` - 主交互、聊天查询、分析触发、动态分析项加载。
- `public/js/template-settings.js`、`public/js/preset-prompts.js` - 模板和预设提示词。
- `ai-settings.json`、`model-settings.json`、`custom-templates.json` - 运行配置；可能包含本地状态，改前确认 schema 和影响面。
- `.env`、`.env.example`、`env.example`、`环境配置模板.txt` - 环境变量和示例；不要泄露真实 key。
- `ai_analysis_history/` - AI 分析历史输出。
- `docs/`、`启动说明.md`、`项目说明.md`、`快速开始.md` - 文档可能滞后；代码真值优先看 `server.js`。
- `scripts/ralph/` - Ralph 自动迭代系统；`progress.txt` 只能追加，不能覆盖。

## Key APIs

当前代码中的关键端点：

- `GET /api/status` - 检查 Chatlog HTTP 服务连接。
- `GET /api/chatlog` - 查询聊天消息。
- `GET /api/contacts`、`GET /api/chatrooms`、`GET /api/sessions` - 加载联系人、群聊和会话。
- `POST /api/ai-analysis` - 触发 AI 分析。
- `POST /api/coding-plan` - 基于 MiniMax 生成 coding plan。
- `GET /api/analysis-history`、`GET /api/analysis-history/:id`、`DELETE /api/analysis-history/:id` - 分析历史。
- `POST /api/save-analysis-config`、`GET /api/get-analysis-config` - 分析项配置保存/读取。
- `POST /api/save-scheduled-config`、`GET /api/scheduled-analysis-status`、`POST /api/trigger-scheduled-analysis` - 定时分析配置和触发。
- `GET /api/model-settings`、`POST /api/model-settings`、`POST /api/model-settings/test` - 模型设置和连通性测试。

不要把旧文档里的端点名当真值；新增或修改 API 时先用 `rg "app\\.(get|post|delete)\\(" server.js` 核对。

## Coding Conventions

- 优先最小可行修改，遵循当前集中式 `server.js` + `views/index.ejs` + `public/js/*.js` 结构；只有复杂度明显上升时才拆模块。
- 面向用户的错误信息用中文；开发者日志可以中英混合，但要包含足够上下文。
- Chatlog API 返回结构要做兼容解析，参考 `parseJSONResponse()`、`extractMessages()`、`formatContactData()`、`formatChatroomData()`。
- 模型 provider 必须通过 `getProviderKey()`、`normalizeModelSettings()`、`getModelConfig()` 这条路径处理。
- `.env` 是 API key 单一真值；前端和 `model-settings.json` 不应保存真实 key。`GET /api/model-settings` 只能返回 `hasApiKey`。
- MiniMax provider key 使用 `minimax`，DOM id 和字段名保持小写；显示文案可以是 `MiniMax`。
- 动态分析项统一使用 canonical id：数组项用裸 id，顶层配置用 `dynamic_<id>`。读写时用 `normalizeAnalysisConfig()` 保持 `dynamicAnalysisItems` 与顶层 `dynamic_*` 双向一致。
- JSON 配置写盘目标规则：优先使用 `atomicWriteJsonSync(filePath, data)`。当前 `model-settings` 路径仍存在直接 `fs.writeFileSync`，改到该路径时应顺手收敛为原子写，不要扩大到无关重构。
- 前端新增或修改 `public/js/*.js` 后，确认 `views/index.ejs` 中的 `<script src>` 仍带 `?v=<%= Date.now() %>`。

## Testing And Verification

基础语法闸门：

```bash
node --check server.js
node --check public/js/app.js
node --check public/js/ai-settings.js
node --check public/js/model-settings.js
```

涉及定时任务时额外运行：

```bash
node --check test-scheduler.js
```

配置保存类需求必须做真实 round-trip：

1. 通过 API 或 UI 保存配置。
2. 再用 `GET /api/get-analysis-config` 或 `GET /api/model-settings` 读取。
3. 必要时重启服务后再次读取。
4. 对动态分析项，同时核对 `dynamicAnalysisItems` 数组和顶层 `dynamic_*` 配置。

UI 改动要实际打开 `http://localhost:3000` 验证关键路径。改 `views/index.ejs`、前端 JS、API 或配置保存逻辑时，至少覆盖：服务可访问、Chatlog 连接状态、设置弹窗、保存按钮、分析项加载。

## Safety Notes

- worktree 经常存在 unrelated dirty files，尤其 `.env`、`ai-settings.json`、`model-settings.json`、`server.log`、`node_modules/.package-lock.json`。只改任务相关文件，不要顺手整理或回滚用户/运行态变更。
- 不要自动 commit、push、reset、rebase、merge，除非用户明确要求，或当前 Ralph 指令明确要求并且用户已选择自动迭代模式。
- `.env`、运行配置和分析历史可能包含敏感信息；不要贴出真实 API key 或隐私聊天内容。
- 修改 JSON 配置前建议备份，例如 `cp ai-settings.json ai-settings.json.bak.$(date +%Y%m%d-%H%M%S)`。
- 禁止使用任何脚本批量删除文件或目录。必须删除时，只能一个文件一个文件处理，并先说明风险；如果必须批量删除，停止并让用户手动确认。
- macOS 上若服务读取本仓库文件出现 `EPERM`，先检查 `com.apple.provenance` / xattr / 权限问题。需要用户在宿主环境处理时，给出明确命令和风险说明，不要把 API 读取失败误判为业务逻辑失败。
- 涉及依赖升级、全局安装、权限修改、系统路径、长时间任务、API quota 消耗时，先说明风险、dry-run、验证和回滚方式。

## Ralph Automation

- `scripts/ralph/prd.json` 是真实 PRD 输入；不存在或不合法时不要猜需求。
- 每次 Ralph 迭代只处理一个未通过且未阻塞的最高优先级 story。
- `scripts/ralph/progress.txt` 必须追加写入，不能覆盖；可复用 pattern 写到顶部 `## Codebase Patterns`。
- Ralph 模式下如果完成 story 并通过检查，按 Ralph 指令提交；普通编码任务不要自动提交。

## Content Production Context

当任务涉及文章、教程、测评或发布物，默认站在 AI 工具研究者视角输出：

- 解决什么问题
- 适合谁 / 不适合谁
- 实测流程
- 优点、缺点、替代方案
- 使用成本和限制
- 最终判断

Obsidian 沉淀默认使用 Markdown，并建议 `tags`、`aliases`、`created`、`status` frontmatter。
