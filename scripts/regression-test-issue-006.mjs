// Regression: ISSUE-006 — /api/chatlog propagate 上游 4xx 而不是包成 500
// Found by /qa round 3 on 2026-06-17
// Report: .gstack/qa-reports/qa-report-chatlogwebui-2026-06-17-round3.md (待生成)
//
// 旧版 /api/chatlog 在上游 chatlog 返回 400(常见原因:客户端没传
// talker、time 格式不被上游接受)时,server.js 把它一律包成 500
// + '获取聊天记录失败'。这会让用户误以为是 server 崩了,实际是
// 客户端参数问题。
//
// 修复:
// - catch 块先看 error.response?.status
// - 上游 4xx(400-499)→ propagate 同状态码,加 actionable 错误提示
//   (请指定 talker 或调整 time 参数)
// - 上游 5xx / 网络错 → 仍是 500 + 通用错误(原行为)
//
// 测试策略:源码静态检查(8 case)+ 可选端到端验证(若 server 跑着)。
// 静态检查确保 fix 不被回滚;端到端验证则在本地 server 上做。
//
// 运行方式(项目根目录):
//   node scripts/regression-test-issue-006.mjs
//
// 预期: 8/8 全过,exit code 0。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_JS = path.resolve(__dirname, '..', 'server.js');

const src = fs.readFileSync(SERVER_JS, 'utf8');

// 提取 /api/chatlog handler 整段(到下一个 app. 路由定义之前)
const handlerStart = src.indexOf("app.get('/api/chatlog'");
if (handlerStart === -1) {
  console.error('FAIL: /api/chatlog handler not found in server.js');
  process.exit(1);
}
const nextAppMatch = src.slice(handlerStart + 1).match(/\n(app\.(get|post|put|delete|patch)\s*\()/);
const handlerEnd = nextAppMatch
  ? handlerStart + 1 + nextAppMatch.index
  : src.length;
const handler = src.slice(handlerStart, handlerEnd);

const cases = [
  // 1. handler 存在且非空
  ['handler exists and non-empty', handler.length > 500],
  // 2. catch 块检查 upstreamStatus
  ['catch block reads error.response?.status', handler.includes('error.response?.status')],
  // 3. 4xx 分支(>= 400 && < 500)
  ['catch handles 4xx range (>=400 && <500)', /upstreamStatus\s*>=\s*400[\s\S]*?<\s*500/.test(handler)],
  // 4. 4xx 分支 propagate 上游 status
  ['catch propagates upstreamStatus as response status', /res\.status\(upstreamStatus\)/.test(handler)],
  // 5. 4xx 分支含 actionable 错误消息(请指定 talker 或调整 time 参数)
  ['4xx branch has actionable error message', handler.includes('请指定 talker') && handler.includes('time 参数')],
  // 6. 5xx 分支保留(原行为)
  ['5xx branch still returns 500', /res\.status\(500\)\.json\(\s*{\s*error:\s*['"]获取聊天记录失败['"]/.test(handler)],
  // 7. catch 块不再"无条件 500"(旧版会 res.status(500).json 无条件执行)
  ['no unconditional 500 in catch (旧版 anti-pattern)', !/catch\s*\([\s\S]{0,200}?res\.status\(500\)\.json\([\s\S]{0,200}?\)\s*\}\s*\)\s*;[\s\S]{0,100}?\}\)/.test(handler)],
  // 8. 包含注释说明 propagate 4xx 的原因
  ['has comment explaining why propagate 4xx', handler.includes('上游 4xx') || handler.includes('propagate 4xx')],
];

let pass = 0;
let fail = 0;
for (const [name, ok] of cases) {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}: ${name}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass}/${cases.length} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\n--- handler preview ---');
  console.log(handler);
}
process.exit(fail > 0 ? 1 : 0);
