// 真实浏览器里跑 FindBar.jumpWhole：验证"目标不在 DOM 时翻页并定位""已在 DOM 时不翻页"
// "并发跳转后 busy 复位"。不启动 App —— mock 会话滚动容器 + stub ctx/React 载入 client.js。
import { readFileSync } from 'node:fs';
// playwright-core 解析顺序：$PLAYWRIGHT_CORE → 普通 import → desktop profile 里的副本
async function loadChromium() {
  const tries = [
    process.env.PLAYWRIGHT_CORE,
    'playwright-core',
    'playwright',
    '/Users/bobolee/.dsh/profiles/desktop/node_modules/playwright-core/index.mjs',
  ].filter(Boolean);
  let last;
  for (const spec of tries) {
    try {
      const mod = await import(spec.startsWith('/') ? spec : spec);
      if (mod.chromium) return mod.chromium;
      if (mod.default && mod.default.chromium) return mod.default.chromium;
    } catch (err) { last = err; }
  }
  throw new Error('找不到 playwright-core：npm i -g playwright-core 或设置 PLAYWRIGHT_CORE；' + (last && last.message));
}
const chromium = await loadChromium();

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const HTML = `<!doctype html><html><body style="margin:0">
  <div id="view" data-conversation-scroll style="height:400px;overflow-y:auto;border:1px solid #333">
    <div id="rows"></div>
  </div>
</body></html>`;

// 页面内工具：往 #rows 追加/前插行；only targetRow 那行含关键词
const pageTools = `
window.seedRows = (from, to, opts) => {
  const rows = document.getElementById('rows');
  const frag = document.createDocumentFragment();
  for (let i = from; i < to; i += 1) {
    const row = document.createElement('div');
    row.setAttribute('data-chat-anchor-key', 'n' + i);
    row.style.cssText = 'height:80px;padding:6px';
    if (opts && opts.targetRow === i) {
      row.innerHTML = '<span>older </span><span>cluster</span><span> text here</span>';
    } else {
      row.textContent = 'row ' + i + ' plain body';
    }
    frag.appendChild(row);
  }
  if (opts && opts.prepend) rows.prepend(frag); else rows.appendChild(frag);
};
window.__h = (() => {
  const mod = { id: null, factory: null };
  window.__ModuleLoader__ = { load: (m) => { mod.id = m.id; mod.factory = m.factory; } };
  const refs = [], cbs = [], sets = {};
  let qi = 0, si = 0;
  let queue = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const idx = si++;
      const v = qi < queue.length ? queue[qi++] : init;
      return [v, (nv) => { sets[idx] = nv; }];
    },
    useEffect: () => {},
    useCallback: (fn) => { cbs.push(fn); return fn; },
    useRef: (init) => { const r = { current: init }; refs.push(r); return r; },
    Fragment: 'Fragment',
  };
  const reset = (q) => { refs.length = 0; cbs.length = 0; qi = 0; si = 0; queue = q || []; };
  return { mod, refs, cbs, sets, React, reset };
})();
`;

// 载入插件并返回 { jumpWhole, refs, sets }
const boot = `
window.__boot = (queue, hits) => {
  const h = window.__h;
  const plugin = h.mod.factory(() => h.React);
  const registered = [];
  plugin.apply({
    slots: {
      inject: (name, cb) => registered.push({ name, cb }),
      register: (opts, comp) => ({ opts, comp }),
    },
    locale: { register: () => {}, bind: () => (k, a) => (a && a.count !== undefined ? k + ':' + a.count : k) },
    effect: (fn) => fn(),
    layout: { selectPanel: () => {} },
    sessions: { using: () => Promise.resolve(), list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    uiWorkspace: { openSession: () => {} },
  });
  const FindBar = registered.find((r) => r.name === 'shell.overlay').cb().comp;
  h.reset(queue);
  const loadCalls = [];
  const props = {
    t: (k, a) => (a && a.count !== undefined ? k + ':' + a.count : k),
    loadThrough: async (seq) => { loadCalls.push(seq); if (window.__loadRows) window.__loadRows(seq); },
    findSessionId: () => 's1',
  };
  FindBar(props);
  // refs 顺序：busyRef, wholeHitsRef, wholeIndexRef, matchesRef, indexRef, lastQueryRef, inputRef, layerRef
  h.refs[1].current = hits;
  return { jumpWhole: h.cbs[1], loadCalls, refs: h.refs, sets: h.sets };
};
`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.setContent(HTML);
await page.addScriptTag({ content: pageTools });
await page.addScriptTag({ content: boot });
await page.addScriptTag({ content: SRC });

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

const HIT = { sessionId: 's1', seq: 3, type: 'assistant/message', time: 1, surface: 'current', snippet: 'older \uFDD0cluster\uFDD1 text here' };
const QUEUE = [false, 'cluster', -1, 0, 0, 1, 1, -1, false]; // open, query, index, total, revision, wholeTotal, wholeShown, wholeIndex, busy

// ---- 场景 1：目标不在 DOM（只有第 20-49 行），应当 loadThrough(3) 后定位到第 3 行
const r1 = await page.evaluate(async ({ hit, queue }) => {
  window.seedRows(20, 50, {});
  window.__loadRows = () => window.seedRows(0, 20, { targetRow: 3, prepend: true });
  const app = window.__boot(queue, [hit]);
  const sc = document.getElementById('view');
  if (!sc) return { error: 'no #view' };
  const before = sc.scrollTop;
  await app.jumpWhole(0);
  await new Promise((r) => setTimeout(r, 700));   // 等平滑滚动结束
  const target = document.querySelector('[data-chat-anchor-key="n3"]');
  if (!target) return { error: 'no n3', loadCalls: app.loadCalls, after: sc.scrollTop };
  const box = sc.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  return {
    loadCalls: app.loadCalls,
    before,
    after: sc.scrollTop,
    hasTarget: !!target,
    offset: rect ? Math.abs((rect.top + rect.height / 2) - (box.top + box.height / 2)) : -1,
  };
}, { hit: HIT, queue: QUEUE });

if (r1.error) console.log('R1 ERROR:', r1.error, JSON.stringify(r1));
check('目标不在 DOM 时调用了 loadThrough', (r1.loadCalls||[]).length === 1 && r1.loadCalls[0] === 3, JSON.stringify(r1.loadCalls));
check('翻页后目标行在页面里', r1.hasTarget, String(r1.hasTarget));
check('翻页后滚动位置变化', Math.abs(r1.after - r1.before) > 20, `${r1.before}→${r1.after}`);
check('目标行落在视口中心附近', r1.offset >= 0 && r1.offset < 120, `offset=${Math.round(r1.offset)}px`);

// ---- 场景 2：目标已在 DOM（第 3 行已存在），不应再翻页
const r2 = await page.evaluate(async ({ hit, queue }) => {
  // 现在 n3 已经在 DOM 里（场景 1 前插过）
  const sc = document.getElementById('view');
  sc.scrollTop = 0;
  const app = window.__boot(queue, [hit]);
  await app.jumpWhole(0);
  await new Promise((r) => setTimeout(r, 700));
  const target = document.querySelector('[data-chat-anchor-key="n3"]');
  if (!target) return { error: 'no n3', loadCalls: app.loadCalls };
  const box = sc.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  return { loadCalls: app.loadCalls, offset: Math.abs((rect.top + rect.height / 2) - (box.top + box.height / 2)) };
}, { hit: HIT, queue: QUEUE });

if (r2.error) console.log('R2 ERROR:', r2.error);
check('目标已在 DOM 时不翻页', (r2.loadCalls||[]).length === 0, JSON.stringify(r2.loadCalls));
check('已在 DOM 时也能定位', r2.offset < 120, `offset=${Math.round(r2.offset)}px`);

// ---- 场景 3：连按两次只保留最后一次，且 busy 复位
const r3 = await page.evaluate(async ({ hit, queue }) => {
  const app = window.__boot(queue, [hit]);
  const p1 = app.jumpWhole(0);
  const p2 = app.jumpWhole(0);
  await Promise.all([p1, p2]);
  await new Promise((r) => setTimeout(r, 400));
  return { busySets: app.sets[8], calls: app.loadCalls.length };
}, { hit: HIT, queue: QUEUE });

check('并发跳转后 busy 复位为 false', r3.busySets === false, String(r3.busySets));
check('并发两次跳转只翻一次页', r3.calls <= 1, `${r3.calls} 次`);

// ---- 场景 4：翻页失败（loadThrough 抛错）也要给出落点，不能什么都不做
const r4 = await page.evaluate(async ({ hit, queue }) => {
  const h = window.__h;
  const plugin = h.mod.factory(() => h.React);
  const reg = [];
  plugin.apply({
    slots: { inject: (n, cb) => reg.push({ n, cb }), register: (o, c) => ({ opts: o, comp: c }) },
    locale: { register: () => {}, bind: () => (k) => k },
    effect: (fn) => fn(),
    layout: { selectPanel: () => {} },
    sessions: { using: () => Promise.resolve(), list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    uiWorkspace: { openSession: () => {} },
  });
  const FindBar = reg.find((r) => r.n === 'shell.overlay').cb().comp;
  h.reset(queue);
  FindBar({
    t: (k) => k,
    loadThrough: async () => { throw new Error('boom'); },
    findSessionId: () => 's1',
  });
  h.refs[1].current = [hit];
  await h.cbs[1](0);
  await new Promise((r) => setTimeout(r, 300));
  return { busySets: h.sets[8] };
}, { hit: HIT, queue: QUEUE });

check('loadThrough 抛错后 busy 也复位', r4.busySets === false, String(r4.busySets));

await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
