// scrollElementIntoView 的真实浏览器测试：只滚会话容器、不动窗口；远距离瞬时、近距离平滑。
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
const fnSrc = extract('scrollHostFor') + '\n' + extract('scrollElementIntoView');

const HTML = `<!doctype html><html><body style="margin:0">
<div style="height:3000px"></div>
<div id="scroller" data-conversation-scroll style="height:500px;overflow:auto;position:relative">
  ${Array.from({ length: 40 }, (_, i) => `<div class="row" data-i="${i}" style="height:100px">row ${i} symbol</div>`).join('')}
</div>
<div style="height:3000px"></div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.setContent(HTML);

await page.addScriptTag({
  content: `${fnSrc}
window.__scrollTo = (el, opts) => scrollElementIntoView(el, opts);`,
});

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

// 1) 远距离：容器从 0 跳到第 30 行
const r1 = await page.evaluate(() => {
  const sc = document.getElementById('scroller');
  sc.scrollTop = 0;
  const before = sc.scrollTop;
  const winBefore = window.scrollY;
  window.__scrollTo(document.querySelector('[data-i="30"]'), undefined);
  return { before, after: sc.scrollTop, winBefore, winAfter: window.scrollY };
});
check('远距离跳转容器滚动了', r1.after > r1.before + 100, `${r1.before}→${r1.after}`);
check('远距离是瞬时落位（调用后立即到位）', Math.abs(r1.after - (30 * 100 - 200)) < 160, `scrollTop=${r1.after}`);
check('不动窗口', r1.winAfter === r1.winBefore, `${r1.winBefore}→${r1.winAfter}`);

// 2) 近距离：平滑滚动，调用后立刻读还是旧值，400ms 后到位
const r2 = await page.evaluate(async () => {
  const sc = document.getElementById('scroller');
  sc.scrollTop = 30 * 100 - 200;
  await new Promise((r) => setTimeout(r, 60));
  const before = sc.scrollTop;
  window.__scrollTo(document.querySelector('[data-i="31"]'), undefined);
  const immediate = sc.scrollTop;
  await new Promise((r) => setTimeout(r, 500));
  return { before, immediate, later: sc.scrollTop, scrollH: sc.scrollHeight, clientH: sc.clientHeight };
});
check('近距离是平滑（立即读未到位）', Math.abs(r2.immediate - r2.before) < 5, `${r2.before}→${r2.immediate}`);
check('近距离最终到位', r2.later > r2.before + 40, `later=${r2.later} h=${r2.scrollH}/${r2.clientH}`);

// 3) 已经居中：不滚
const r3 = await page.evaluate(async () => {
  const sc = document.getElementById('scroller');
  const el = document.querySelector('[data-i="20"]');
  const box = sc.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  sc.scrollTop += (rect.top + rect.height / 2) - (box.top + box.height / 2);
  await new Promise((r) => setTimeout(r, 60));
  const before = sc.scrollTop;
  window.__scrollTo(el, undefined);
  return { before, after: sc.scrollTop };
});
check('已居中时不抖动', Math.abs(r3.after - r3.before) <= 1, `${r3.before}→${r3.after}`);

// 4) instant 选项：近距离也立刻到位
const r4 = await page.evaluate(() => {
  const sc = document.getElementById('scroller');
  sc.scrollTop = 30 * 100 - 200;
  const before = sc.scrollTop;
  window.__scrollTo(document.querySelector('[data-i="31"]'), { instant: true });
  return { before, after: sc.scrollTop };
});
check('instant 近距离也立即到位', Math.abs(r4.after - r4.before) > 40, `${r4.before}→${r4.after}`);


// 8) 宿主标记不是真正的滚动元素（外壳 overflow:visible，内层才滚）：也要能定位
const page2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page2.setContent(`<!doctype html><html><body style="margin:0">
<div data-conversation-scroll style="overflow:visible">
  <div id="inner" style="height:500px;overflow:auto">
    ${Array.from({ length: 40 }, (_, i) => `<div class="row" data-i="${i}" style="height:100px">row ${i}</div>`).join('')}
  </div>
</div>
</body></html>`);
await page2.addScriptTag({ content: `${fnSrc}\nwindow.__scrollTo = (el, opts) => scrollElementIntoView(el, opts);` });
const r8 = await page2.evaluate(async () => {
  const inner = document.getElementById('inner');
  inner.scrollTop = 0;
  window.__scrollTo(document.querySelector('[data-i="25"]'));
  await new Promise((r) => setTimeout(r, 700));
  return { top: inner.scrollTop, docTop: document.documentElement.scrollTop || window.scrollY };
});
check('外层不可滚时命中内层滚动元素', r8.top > 1000, `inner.scrollTop=${r8.top}`);
check('不动文档滚动', r8.docTop === 0, String(r8.docTop));
await page2.close();

await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
