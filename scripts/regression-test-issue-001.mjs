// Regression: ISSUE-001 — getProviderKey must accept lowercase provider
// Found by /qa on 2026-06-17
// Report: .gstack/qa-reports/qa-report-chatlogwebui-2026-06-17.md
//
// 加载 server.js 的 getProviderKey,验证对 lowercase / PascalCase / 混合大小写
// 都返回正确的 lowercase 键名;对 null/undefined/未知 provider 安全返回 null。
//
// 运行方式(项目根目录):
//   node scripts/regression-test-issue-001.mjs
//
// 预期: 15/15 全过,exit code 0。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_JS = path.resolve(__dirname, '..', 'server.js');

const src = fs.readFileSync(SERVER_JS, 'utf8');
const m = src.match(/function getProviderKey\(provider\)\s*{[\s\S]*?\n}/);
if (!m) {
  console.error('FAIL: getProviderKey not found in server.js');
  process.exit(1);
}
const fn = new Function('return (' + m[0] + ')')();

const cases = [
  // PascalCase(原始支持)
  ['DeepSeek', 'deepseek'],
  ['Gemini', 'gemini'],
  ['MiniMax', 'minimax'],
  // lowercase(AGENTS.md §Coding Conventions 规定的配置键名)
  ['deepseek', 'deepseek'],
  ['gemini', 'gemini'],
  ['minimax', 'minimax'],
  // 混合大小写
  ['DEEPSEEK', 'deepseek'],
  ['GEMINI', 'gemini'],
  ['MINIMAX', 'minimax'],
  ['Deepseek', 'deepseek'],
  ['miniMax', 'minimax'],
  // 边界:null / undefined / 空 / 未知
  [null, null],
  [undefined, null],
  ['', null],
  ['openai', null],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const actual = fn(input);
  const ok = actual === expected;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}: getProviderKey(${JSON.stringify(input)}) = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass}/${cases.length} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
