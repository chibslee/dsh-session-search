// waitForLanding 的单元测试：不启动 App，用假 document 验"等 DOM 落位"与令牌取消。
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 按花括号配对抠出一个函数定义
function extract(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced: ${name}`);
}

const fnSrc = extract('waitForLanding');

// ---- 场景：行数从 3 变 5，第 5 行才含强匹配
let jumpToken = 1;
let rows = 3;
let matchRows = [];
let scans = 0;

const document = {
  querySelector: () => ({ querySelectorAll: () => ({ length: rows }) }),
};
const collectMatches = () => {
  scans += 1;
  return matchRows.map((r) => ({ node: { parentElement: { row: r } } }));
};
const rowOf = (node) => node.parentElement;
const contextScore = (el, hint) => (el && el.row === hint ? 9 : 0);
const pickBestMatch = (matches, hint) => {
  let best = 0; let score = -1;
  matches.forEach((m, i) => { const s = contextScore(rowOf(m.node), hint); if (s > score) { score = s; best = i; } });
  return best;
};

// 用 getter 让函数体里读到的 jumpToken 跟着变
const holder = { token: 1 };
Object.defineProperty(globalThis, 'jumpToken', { get: () => holder.token, configurable: true });

globalThis.document = document;
globalThis.collectMatches = collectMatches;
globalThis.rowOf = rowOf;
globalThis.contextScore = contextScore;
globalThis.pickBestMatch = pickBestMatch;

const waitForLanding = new Function(`
  ${fnSrc}
  return waitForLanding;
`)();

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

// 1) 一开始行数没变（3），matchRows 是空 → 一直等到行数变化
matchRows = [];
const p1 = waitForLanding('sym', 'row5', 1, 1500);
setTimeout(() => { rows = 5; matchRows = ['row1', 'row5']; }, 180);
const r1 = await p1;
check('等到 DOM 落位后返回', r1 && r1.best === 1, JSON.stringify(r1 && { best: r1.best, len: r1.matches.length }));
check('行数没变时不重扫 DOM', scans <= 3, `scans=${scans}`);

// 2) 令牌变化 → 立刻退出，不滚动
holder.token = 99;
rows = 7;
const t0 = Date.now();
const r2 = await waitForLanding('sym', 'row5', 1, 3000);
check('令牌失效时返回 null', r2 === null, String(r2));
check('令牌失效时快速退出', Date.now() - t0 < 200, `${Date.now() - t0}ms`);

// 2b) 行数不变但内容后来才到：靠 250ms 周期重扫抓到
holder.token = 7;
rows = 5; matchRows = [];
const p4 = waitForLanding('sym', 'row9', 7, 1600);
setTimeout(() => { matchRows = ['row9']; }, 600);   // 行数不变
const r4 = await p4;
check('行数不变也会周期重扫并命中', r4 && r4.best === 0, JSON.stringify(r4 && { best: r4.best, len: r4.matches.length }));

// 3) 一直等不到 → 超时返回 null
holder.token = 5;
rows = 8; matchRows = [];
const t1 = Date.now();
const r3 = await waitForLanding('sym', 'nope', 5, 400);
const waited = Date.now() - t1;
check('超时返回 null', r3 === null, String(r3));
check('超时时间合理（300-1200ms）', waited >= 300 && waited < 1200, `${waited}ms`);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
