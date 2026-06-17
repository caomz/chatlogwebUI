// Regression: ISSUE-005 — /api/test-deepseek error response 不回显 API key 前缀
// Found by /qa round 2 on 2026-06-17
// Report: .gstack/qa-reports/qa-report-chatlogwebui-2026-06-17-round2.md
//
// 旧版 /api/test-deepseek(遗留调试端点,前端未调用)在 500 错误 response 里返回
//   apiKey: DEEPSEEK_API_KEY.substring(0, 8) + '****'
// 任何能访问该 endpoint 的人(developer / monitoring)能拿到 key 前 8 位。
// 同步把 console.log 里的 key 前缀打印改成 '是否已配置' 状态,避免 server 日志泄露。
//
// 修复:
// - 删除 response 里的 apiKey 字段
// - console.log 改为只显示 key 是否已配置(布尔)
// - 加注释说明不回显 key 的原因
//
// 静态检查策略:这个 endpoint 行为只在 server 运行时才能完整验证(需要重启
// server.js 让 fix 生效),但「源码不应回显 key 前缀」是可以离线断言的。
// 本测试用正则扫描 server.js,确认 /api/test-deepseek handler 范围内不再含
// 任何会回显 key 前缀的模式(DEEPSEEK_API_KEY.substring / slice / slice(0, n) 等)。
//
// 运行方式(项目根目录):
//   node scripts/regression-test-issue-005.mjs
//
// 预期: 8/8 全过,exit code 0。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_JS = path.resolve(__dirname, '..', 'server.js');

const src = fs.readFileSync(SERVER_JS, 'utf8');

// 提取 /api/test-deepseek handler 整段(到下一个 app. 路由定义之前)
const handlerStart = src.indexOf("app.get('/api/test-deepseek'");
if (handlerStart === -1) {
  console.error('FAIL: /api/test-deepseek handler not found in server.js');
  process.exit(1);
}
// 找下一个 app.get 或 app.post 位置
const nextAppMatch = src.slice(handlerStart + 1).match(/\n(app\.(get|post|put|delete|patch)\s*\()/);
const handlerEnd = nextAppMatch
  ? handlerStart + 1 + nextAppMatch.index
  : src.length;
const handler = src.slice(handlerStart, handlerEnd);

const cases = [
  // 1. handler 存在且不为空
  ['handler exists and non-empty', handler.length > 200],
  // 2. 不再含 "API密钥前8位" 字符串(旧版 console.log 文本)
  ['no "API密钥前8位" log (replaced with "是否已配置")', !handler.includes('API密钥前8位')],
  // 3. 不再含 "DEEPSEEK_API_KEY.substring" 模式(可能回显 key 前缀)
  ['no DEEPSEEK_API_KEY.substring() call', !/DEEPSEEK_API_KEY\.substring/.test(handler)],
  // 4. 不再含 ".slice(0," 模式(可能回显 key 前缀)
  ['no .slice(0,...) call on DEEPSEEK_API_KEY', !/DEEPSEEK_API_KEY\s*\.slice\(/.test(handler) && !/DEEPSEEK_API_KEY\s*\.substring\(/.test(handler)],
  // 5. 错误 response 不再含 "apiKey" 字段
  ['error response has no "apiKey" field', !/res\.status\(500\)\.json\(\s*{[\s\S]*?apiKey\s*:/.test(handler)],
  // 6. console.log 改为 "是否已配置"
  ['console.log replaced with "是否已配置" message', handler.includes('API密钥是否已配置')],
  // 7. 含注释说明不回显 key
  ['has comment explaining no key echo', handler.includes('不回显 key') || handler.includes('不回显key') || handler.includes('不回显 API key') || handler.includes('不在 HTTP response 里回显 key')],
  // 8. 仍然能真正发请求测试(key 还是从 .env 读)
  ['still uses DEEPSEEK_API_KEY in Authorization header', handler.includes('Authorization') && handler.includes('Bearer ${DEEPSEEK_API_KEY}')],
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
