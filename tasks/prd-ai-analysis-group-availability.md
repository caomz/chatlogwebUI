# PRD: 修复 AI 智能分析中心群聊可用性 + 相关风险治理

> 配套实施计划：`.agents/plans/fix-ai-analysis-group-availability.md`（含逐任务的代码改动细节与 file:line 引用）。本 PRD 把同一功能拆成可独立验证的 user story，供 MiniMax 逐个会话执行。
>
> ⚠️ 执行模型为 MiniMax：每个 story 小到一次会话可完成；acceptance criteria 全部为机械可验证的单点结果；做完一个 story 先验证再进下一个。

## Introduction / 概述

AI 智能分析中心配置了 10 个分析项（3 固定 + 7 动态），每项绑定一个微信群聊。用户反馈：群聊在配置下拉里**都能选到**，但实际只有**两个群**能出结果，其余报「未找到聊天数据」而被误判为「不可用」。

经代码审查 + chatlog 实测 + preview 端到端 + 6-17 定时任务复盘，已确认：**这不是群聊匹配问题，而是「所选时间范围 × 该群当天活跃度」问题**——多数分析项 `timeRange='yesterday'`，而群在「昨天」恰好没消息时返回空，端点抛出含糊错误。6-15(周一群不活跃)只有 2 个群有消息→「只有两个可用」；6-16(周二)定时任务则 8 成功。本质是按日复发的体验缺陷，叠加几个独立风险（非法时间值 500、图片识别 404、定时无重入锁、数据时效性无告警）。

本 PRD 的目标：让**配置正确的分析项**要么成功产出，要么给出**明确可操作**的失败原因；并顺带治理强相关的稳定性/数据卫生风险。

## Goals

- 消除「群聊被误判为不可用」：空结果时区分「群名无效」与「该时段无消息」，并告知群最近消息日期。
- 非法/未知时间关键词不再导致 chatlog 400 / 服务 500。
- 定时分析尊重各分析项配置的 `timeRange`（缺省回退「昨天」），与设置界面一致。
- 清理脏数据：删除无效的「端到端测试群」项，修正被误标删除的 minmax 38 群。
- 图片识别失败不再反复重试浪费（负缓存），并定位 404 根因。
- 定时批量分析具备重入保护；全跳过时发出醒目告警。

## User Stories

> 依赖顺序：US-001（前置）→ US-002~US-007（核心修复）→ US-008~US-011（R1/R2/R5）→ US-012（闭环集成）。
> 多数 story 的运行时验证依赖 **Chatlog 在线（US-001）**，已在各自 AC 标注。

---

### US-001: 【前置】确认 Chatlog HTTP 服务在线可达
**描述：** 作为执行者，我需要 Chatlog HTTP 服务在线，以便后续所有依赖真实聊天数据的验证能真正跑通，而不是对着掉线的后端做假验证。

**Acceptance Criteria：**
- [ ] `curl -sS --max-time 5 http://127.0.0.1:5030/api/v1/chatrooms?format=json` 返回 HTTP 200 且 body 含 `"chatrooms"`
- [ ] `curl -sS http://localhost:3000/api/status`（或 preview 实例对应端口）返回 `"status":"connected"`
- [ ] 若不可达：明确停下并提示用户「请先启动 Chatlog 应用（监听 127.0.0.1:5030）」，不要继续做依赖 chatlog 的 story 的运行时验证
- [ ] 记录当日「昨天」是否有数据的基线：`curl "http://127.0.0.1:5030/api/v1/history?chat=MiniMax 官方交流群 38 群&time=<昨天>~<昨天>&limit=5&format=json"` 能返回非空

---

### US-002: normalizeChatlogTime 健壮化（修非法时间值 500 + 时间别名）✅ 已完成
**描述：** 作为系统，我需要把未知/别名时间关键词安全归一化，以便非法值（如 `last_3_days`）不再透传给 chatlog 导致 400/500。

> 状态：✅ 已于本轮实施并通过离线验证（`server.js:125` normalizeChatlogTime 已补别名 + 未知值回退最近7天 + console.warn）。保留此 story 以反映功能全貌，验收项作为回归基线。

**Acceptance Criteria：**
- [x] `node --check server.js` 通过
- [x] 纯函数单测：`yesterday`/`week` 映射为正确的 `YYYY-MM-DD~YYYY-MM-DD`
- [x] `last_3_days` / `3days` / `recent_3_days` 映射为「最近3天」区间
- [x] `all` / `全部` / `all_time` 映射为 `2020-01-01~今天`
- [x] 未知关键词（如 `xyz`）回退「最近7天」并打印 `console.warn` 告警，**不再原样返回**
- [x] 自定义区间 `2026-01-01~2026-01-02` 原样透传不改写
- [ ] 【前置 US-001】`GET /api/chatlog?talker=<存在的群>&time=last_3_days&limit=5` 返回 HTTP 200（修复前为 500）

---

### US-003: 新增 probeGroupActivity(talker) helper
**描述：** 作为系统，我需要在某次查询为空时探测该群「是否有过任何消息、最近一条消息日期」，以便区分「群名无效」与「该时段无消息」。

**Acceptance Criteria：**
- [ ] `server.js` 新增 `async function probeGroupActivity(talker)`，复用 `getChatData` 同样的 chatlog `/history` 查询方式（`extractMessages`/`parseJSONResponse`/`CHATLOG_API_BASE`）
- [ ] `node --check server.js` 通过
- [ ] 【前置 US-001】对有历史消息的群（如「CRM系统监控」）返回 `{ hasAnyMessage: true, latestDate: 'YYYY-MM-DD', ... }`，`latestDate` 为非空合法日期字符串
- [ ] 【前置 US-001】对不存在的群（如「不存在的群xyz123」）返回 `{ hasAnyMessage: false, latestDate: null }`
- [ ] probe 内部 chatlog 调用抛错时，捕获并返回 `{ hasAnyMessage: null, ... }`，**不向上抛异常**（不得导致调用方 500）
- [ ] 单次查询 `limit` 不超过 500（避免大群拉全量）

---

### US-004: /api/ai-analysis 空结果返回结构化、可区分的失败原因
**描述：** 作为用户，当分析没有数据时，我想知道到底是「群名错了」还是「这个时间段没消息」，以便据此修正而不是以为群坏了。

**Acceptance Criteria：**
- [ ] 空结果分支调用 `probeGroupActivity(groupName)` 后返回，仍保持 `HTTP 200 + { success:false }`（不改为 4xx，避免前端 `!response.ok` 走通用错误）
- [ ] 【前置 US-001】群存在但所选时段无消息（如 `groupName=CRM系统监控`、`timeRange=2020-01-01~2020-01-02`）→ 响应含 `"reason":"empty_in_range"` 且含非空 `latestDate` 字段，`error` 文案包含「最近一条消息时间」与「请调整时间范围」
- [ ] 【前置 US-001】群不存在（`groupName=不存在的群xyz123`）→ 响应含 `"reason":"group_not_found"`，`error` 文案包含「未找到群聊」与群名
- [ ] probe 返回未知态（`hasAnyMessage===null`）→ 回退原通用文案 `"未找到聊天数据，请检查时间范围和群聊名称是否正确"`，`reason:"unknown"`
- [ ] 不触发真实 AI：以上三条空结果路径均**不**调用 `callAI`（响应在数秒内返回）
- [ ] `node --check server.js` 通过

---

### US-005: 前端在分析失败时展示结构化失败原因（UI）
**描述：** 作为用户，我点击分析项失败时，页面要直接显示后端给出的可操作原因，而不是含糊的「请检查时间范围和群聊名称」。

**Acceptance Criteria：**
- [ ] `public/js/app.js` 的 `startAIAnalysis` 在 `result.success===false` 时，对 `reason==='empty_in_range'` / `reason==='group_not_found'` 用 `showMessage(result.error, 'error')` 展示后端文案；其它情况维持原 throw→catch 行为
- [ ] `node --check public/js/app.js` 通过
- [ ] `views/index.ejs` 中 `app.js` 的 `<script src>` 仍带 `?v=<%= Date.now() %>`（`grep "app.js?v=" views/index.ejs` 命中）
- [ ] 【前置 US-001】使用浏览器预览工具（Claude Preview MCP：`preview_start` autoPort 独立实例 → `preview_eval` 执行 `window.location.reload()`）打开首页
- [ ] 点击一个当前所选时段无消息的群按钮（如「CRM监控」`#analyzeGroup2Btn`，前提该群昨天无消息；或先用设置把其 timeRange 设为明显无数据的区间）
- [ ] `preview_snapshot` / `preview_screenshot` 显示提示文案包含「最近一条消息时间」或「请调整时间范围」，**不再是**仅「请检查时间范围和群聊名称是否正确」
- [ ] `preview_console_logs level=error` 无报错

---

### US-006: 定时分析使用各分析项配置的 timeRange（R3）
**描述：** 作为用户，我在设置里给某个分析项配置了时间范围，定时任务就应该照此执行，而不是被硬编码成「昨天」。

**Acceptance Criteria：**
- [ ] `getAllAnalysisItemsForSchedule()` 默认项（programming/science/reading）的 `timeRange` 改为 `itemSettings.timeRange || 'yesterday'`（与动态项一致，`server.js:1953` 为参照）
- [ ] `executeScheduledAnalysis()` 不再自行重算「昨天」，改用 `normalizeChatlogTime(analysisItem.timeRange || 'yesterday')`
- [ ] `grep -n "analysisItem.timeRange" server.js` 在 `executeScheduledAnalysis` 内命中
- [ ] `grep -n "yesterday.setDate" server.js` 在 `executeScheduledAnalysis` 函数体内**不再出现**
- [ ] 缺省/缺失配置时仍回退「昨天」（取值为 `yesterday`）
- [ ] 不改动 `return { success:false, reason:'无聊天数据' }` 的 `reason` 字符串（`runScheduledBatchAnalysis` 按它分类 skipped）
- [ ] `node --check server.js` 通过

---

### US-007: 删除「端到端测试群」分析项 + 清理 deletedDynamicIds（R4）
**描述：** 作为用户，我不想在分析中心看到一个永远跑不出结果的无效测试项，也不想让真正能用的群被误标删除。

**Acceptance Criteria：**
- [ ] 改 `ai-settings.json` 前已有备份（`ai-settings.json.bak.*` 存在）
- [ ] 从 `dynamicAnalysisItems` 数组移除 id `1780528325028`（端到端测试群），并删除顶层 `dynamic_1780528325028`
- [ ] **保留** minmax 38 群（id `1780527620707`）：数组与顶层 `dynamic_1780527620707` 仍在
- [ ] 从 `deletedDynamicIds` 移除 `dynamic_1780527620707`
- [ ] 校验：`node -e "const c=require('./ai-settings.json'); const inArr=id=>(c.dynamicAnalysisItems||[]).some(i=>String(i.id).includes(id)); console.log(!inArr('1780528325028') && !c['dynamic_1780528325028'] && inArr('1780527620707') && !(c.deletedDynamicIds||[]).some(x=>String(x).includes('1780527620707')))"` 输出 `true`
- [ ] 动态项数量从 7 降为 6；JSON 仍可被 `require()` 正常解析（无语法错误，emoji 群名未损坏）
- [ ] 【前置 US-001】使用预览工具刷新首页后，AI 智能分析中心**不再出现**「端到端测试群」按钮，且「minmax 38 群」按钮仍在；「分析项数量」显示为 9（3 固定 + 6 动态）

---

### US-008: 【调查】诊断图片识别 mmx vision 404 根因（R1）
**描述：** 作为开发者，我需要先弄清图片识别 404 到底是「图片损坏」还是「vision API 间歇性失败」，以便对症修复，而不是盲目改。

**Acceptance Criteria：**
- [ ] 从 `server.log` 收集若干当时报 `API error: HTTP 404` 的 cacheKey（图片 hash）
- [ ] 对这些 cacheKey 对应的 `.cache/mmx-image-analysis/<hash>.jpg` 逐个重跑 `mmx vision describe --image <file> --prompt "识别" --non-interactive --quiet --output json`，记录每张：成功 / 仍 404 / 文件损坏 / 文件大小为 0
- [ ] 产出一段结论（写入本 PRD 的 Open Questions 或单独 note）：404 主因归类为下列之一并附计数——「下载的图片损坏/不完整」「特定格式不支持」「vision API 间歇性 404」「mmx 配置/模型问题」
- [ ] 基线统计：`grep -c "图片识别最终失败" server.log` 与 `grep -c "✅ 图片识别完成" server.log`（或等价成功标记）各记录一个数字
- [ ] 结论明确「US-009 负缓存是否足够，还是需要额外的下载校验/换模型」（决定后续是否新开 story）

> **诊断结论（2026-06-17）**：缓存 484 张 jpg 抽样全部为有效 JPEG（无残缺/非图片），连 944B 最小图现在都能被 mmx 成功识别（exit=0）；mmx 工具与 vision API 当前完全可用。153 次 `API error: HTTP 404` 系**当时 vision 后端的间歇性/批量故障**（非图片损坏、非工具/配置问题），现已恢复。持续性问题仅为「失败图无负缓存→每次分析重复下载+重试浪费」。**因此 US-009 负缓存必须带 TTL**（默认 24h），避免把间歇性后端故障永久化；TTL 过期后允许重试。无需额外下载校验或换模型。

---

### US-009: 图片识别失败做负缓存，避免反复重试浪费（R1）
**描述：** 作为系统，我不想每次分析同一个群都对那些必然失败的图片重复下载 + 重试 2 次，浪费时间和 vision 调用。

**Acceptance Criteria：**
- [ ] `analyzeImageMessageWithMmx`（成功时写 `<cacheKey>.json`，`server.js:648`）扩展为：最终失败时也写一个负缓存结果文件（如 `{ success:false, error, failedAt }`）
- [ ] 二次分析同一图片时，命中负缓存则**直接返回失败、跳过 `mmx` 调用与重试**（不再走 `analyzeImageMessageWithRetry` 的 2 次重试）
- [ ] 负缓存可被清理/有过期策略（如带 `failedAt` 时间戳，或文档说明手动清理 `.cache/mmx-image-analysis/`）
- [ ] `node --check server.js` 通过
- [ ] 单测/可观测：构造一个必失败输入（如指向不存在 msgid 的图片消息），首次分析后 `.cache/mmx-image-analysis/` 下生成对应负缓存文件；第二次分析同一输入时日志**不出现** `🔁 重试图片识别`
- [ ] 不影响成功路径：能成功识别的图片仍写正向缓存并复用

---

### US-010: 定时批量分析增加重入锁（R2）
**描述：** 作为系统，定时任务正在运行时（可能持续数十分钟），我不希望 cron 或用户手动触发又并发跑一轮，导致重复分析、重复写历史、浪费配额。

**Acceptance Criteria：**
- [ ] `runScheduledBatchAnalysis`（`server.js:2087`）增加模块级 `isScheduledRunning` 标志：进入时若已为 true 则记录 `console.warn` 并直接 return；正常/异常结束都在 `finally` 复位为 false
- [ ] `POST /api/trigger-scheduled-analysis`（`server.js:2173`）在已运行时返回明确响应（如 `{ success:false, message:'定时分析正在运行中，请稍后再试' }`），不再叠加并发
- [ ] `node --check server.js` 通过
- [ ] 可观测验证：连续两次快速调用 `POST /api/trigger-scheduled-analysis`，第二次响应/日志表明被拒绝（「正在运行中」），而非启动第二轮
- [ ] cron 定时入口（`server.js:2057`）与手动入口共用同一把锁（不存在绕过路径）

---

### US-011: 定时任务全跳过/全失败时发出醒目告警（R5）
**描述：** 作为用户，如果某天 chatlog 没有昨日数据导致定时分析一个都没产出，我希望日志里有醒目告警，以便及时发现数据源问题，而不是以为系统正常。

**Acceptance Criteria：**
- [ ] `runScheduledBatchAnalysis` 汇总阶段：当 `results.success.length === 0`（全跳过或全失败）时，输出醒目告警行（如 `❌❌ 定时分析 0 成功：疑似 chatlog 无「<时间范围>」数据或服务异常，请检查数据源`）
- [ ] 有任意成功项时**不**触发该告警（避免噪音）
- [ ] 告警包含：分析项总数、成功/跳过/失败计数、所用时间范围
- [ ] `node --check server.js` 通过
- [ ] 可观测验证：在「昨天确实无任何群数据」或构造全跳过的场景下手动触发，`server.log` 出现该醒目告警；在正常有成功的场景下不出现

---

### US-012: 【闭环集成】真实用户路径端到端验证（chatlog 在线）
**描述：** 作为用户，我希望从打开页面到各类分析结果/提示、再到定时与刷新，整条链路一致可用——这是把前面各 story 串起来的最终验收。

**Acceptance Criteria（全部在 chatlog 在线、preview 独立实例下执行）：**
- [ ] 用 `preview_start`（autoPort）启动实例，`preview_eval` 重载首页，`preview_screenshot` 确认分析项按钮渲染正常且**无**「端到端测试群」
- [ ] 点击一个「所选时段有数据」的群（如昨天活跃的 minmax 38 群）→ 分析成功，`preview_snapshot` 出现成功提示/新历史记录；`POST /api/ai-analysis` 在 `preview_network` 中为 200 且 `success:true`
- [ ] 点击一个「群存在但所选时段无消息」的群 → 页面提示含「最近一条消息时间…请调整时间范围」（empty_in_range），用户可据此操作
- [ ] 输入一个不存在的群名（自定义分析表单）→ 提示「未找到群聊…」（group_not_found）
- [ ] `GET /api/chatlog?...&time=last_3_days` 返回 200（非 500）
- [ ] 手动触发定时分析（`POST /api/trigger-scheduled-analysis`）：日志显示各项使用**自身配置的 timeRange**；运行中再次触发被重入锁拒绝；若全跳过则出现醒目告警
- [ ] 刷新页面后：分析项列表、历史记录、定时状态（分析项数量=9）保持一致
- [ ] 全程 `preview_console_logs level=error` 无报错

## Functional Requirements

- FR-1: `normalizeChatlogTime` 必须把已知别名（`last_3_days`/`3days`/`recent_3_days`/`all`/`全部`/`all_time` 等）映射为合法 `YYYY-MM-DD~YYYY-MM-DD`；未知关键词回退「最近7天」并告警；自定义 `~` 区间原样透传。
- FR-2: 系统必须提供 `probeGroupActivity(talker)`，返回 `{ hasAnyMessage: true|false|null, latestDate }`，且自身错误不外抛。
- FR-3: 当 `/api/ai-analysis` 查无数据时，系统必须基于 probe 返回 `reason ∈ {group_not_found, empty_in_range, unknown}` 的结构化结果（HTTP 200 + success:false），`empty_in_range` 须带 `latestDate`。
- FR-4: 空结果路径（三种 reason）均不得调用 AI 模型。
- FR-5: 前端 `startAIAnalysis` 必须在 `empty_in_range`/`group_not_found` 时展示后端 `error` 文案。
- FR-6: 定时分析必须使用各分析项配置的 `timeRange`（缺省回退 `yesterday`），不得硬编码忽略配置。
- FR-7: 系统必须从 `ai-settings.json` 删除无效的「端到端测试群」项（id `1780528325028`），并从 `deletedDynamicIds` 移除 minmax 38 群（id `1780527620707`）。
- FR-8: 图片识别最终失败时，系统必须写入负缓存，二次分析同一图片时跳过 `mmx` 调用与重试。
- FR-9: `runScheduledBatchAnalysis` 必须具备重入锁；运行中触发须被拒绝并提示。
- FR-10: 定时分析「成功 0 个」时，系统必须输出含计数与时间范围的醒目告警。

## Non-Goals（超出范围）

- 不改默认 `timeRange` 语义（定时缺省仍为「昨天」；只在用户显式配置时遵从）。
- 不自动改写用户选定的时间范围（不做「无数据自动回退到最近活跃日」的静默行为；只给提示）。
- 不重写图片识别引擎、不更换 vision 模型（R1 仅做诊断 + 负缓存；若诊断结论要求换模型，另开 story）。
- R5 告警仅写入服务端日志，**不**引入邮件/webhook/IM 等外部通知渠道。
- 不引入新的测试框架；验证沿用 `node --check` + `node -e` 单测 + curl + preview 工具。
- 不改动 chatlog 本身的媒体解密/下载实现。

## Design Considerations

- 错误提示文案为中文、面向用户，复用现有 `this.showMessage(text, 'error')`。
- UI 验证统一使用 **Claude Preview MCP**（`preview_start` 配 `autoPort:true` 起独立实例、`preview_click`/`preview_fill`/`preview_snapshot`/`preview_screenshot`/`preview_console_logs`/`preview_network`），不影响用户已运行的 :3000 实例。
- 复用现有动态项 UI 渲染（`createDynamicAnalysisItemUI`）；删除项后由 `hydrateFromServer` 重新拉取，界面自动少一个按钮。

## Technical Considerations

- 运行时强依赖 **Chatlog HTTP 服务（127.0.0.1:5030）**：US-003/004/005/007/012 的运行时验证必须在其在线时进行（US-001 为前置闸门）。当前环境 chatlog 一度掉线，执行前务必先过 US-001。
- 错误协议约定：`/api/ai-analysis` 维持 `HTTP 200 + {success:false,...}`，仅扩展 `reason`/`latestDate`/`suggestions` 字段，前端无需改 `response.ok` 判断。
- 动态项 id 规范：数组项用裸 id、顶层用 `dynamic_<id>`；US-007 删除时两处都要清。**务必区分** `1780528325028`(端到端，删) 与 `1780527620707`(minmax38，留)。
- JSON 写盘：运行期走 `atomicWriteJsonSync`（`server.js:2347`）；US-007 离线一次性修数据可用 `fs.writeFileSync`（已备份）。
- `node --check server.js / public/js/app.js / test-scheduler.js` 为基础语法闸门，每个改 JS 的 story 必跑。

## Success Metrics

- 配置正确的分析项，在「所选时段有数据」时 100% 可成功产出（无回归）。
- 「所选时段无数据」或「群名无效」时，100% 给出可区分、可操作的提示（用户能据此修正）。
- 非法/未知时间关键词触发的 chatlog 500 降为 0。
- 同一批失败图片的 `mmx` 重试次数显著下降（命中负缓存后为 0 次重试）。
- 定时任务「0 成功」时 100% 出现醒目告警；并发触发 0 次重入。

## Open Questions

- US-008 诊断结论：404 主因若为「下载图片损坏」，是否需要新增「下载后图片完整性校验 + 跳过」story？若为「vision API 间歇」，是否需要退避重试策略调整？
- 定时分析使用 `week`/`month` 配置时，每日会产生时间重叠的报告，是否需要去重或提示用户？（当前按用户配置尊重，不去重）
- 数据时效性告警（R5）当前仅日志，未来是否需要在「定时分析管理」面板用红色状态显式呈现「最近一次 0 成功」？
- 负缓存（US-009）默认是否需要过期时间，还是依赖手动清理 `.cache/mmx-image-analysis/`？
