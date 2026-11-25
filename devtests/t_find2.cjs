// 载入插件 + 渲染查找条：验证插槽注册没坏、busy 时计数显示 '…'、按钮可用性正确。
const { readFileSync } = require('node:fs');

const src = readFileSync(require('node:path').join(__dirname, '..', 'client.js'), 'utf8');

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

const box = { queue: [], effects: [] };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(9) }),
  useState: (init) => {
    const v = box.queue.length ? box.queue.shift() : init;
    return [v, () => {}];
  },
  useEffect: (fn) => { box.effects.push(fn); },
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  Fragment: 'Fragment',
};
const setQueue = (arr) => { box.queue = arr.slice(); };
function makeHarness() { return { React, effects: box.effects }; }

// ---- 1) apply() 注册
const captured = { slots: [], effects: 0, locale: 0, modules: [] };
global.window = {
  __ModuleLoader__: { load: (mod) => { captured.modules.push(mod); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  getSelection: () => null,
  innerHeight: 900,
  fetch: () => Promise.reject(new Error('offline')),
};
global.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createTreeWalker: () => ({ nextNode: () => false }),
  createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }),
  createElement: () => ({ style: {}, dataset: {}, appendChild() {}, textContent: '' }),
  createDocumentFragment: () => ({ appendChild() {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { nodeType: 1 },
  hidden: false,
};

const requireStub = (name) => {
  if (name === 'react') return React;
  return {};
};
eval(src);

const mod = captured.modules[0];
check('模块加载', !!mod && mod.id === 'dsh-keyword-searcher', mod && mod.id);
const plugin = mod.factory(requireStub);

const ctx = {
  slots: {
    inject: (name, cb) => { captured.slots.push({ name, cb }); },
    register: (opts, comp) => ({ slot: opts.name, opts, comp }),
  },
  locale: { register: () => { captured.locale += 1; }, bind: () => (k, a) => (a && a.count !== undefined ? `${k}:${a.count}` : k) },
  effect: (fn) => { captured.effects += 1; fn(); },
  layout: { selectPanel: () => {} },
  sessions: { using: () => Promise.resolve(), list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
  uiWorkspace: { openSession: () => {} },
};
plugin.apply(ctx);

const slotNames = captured.slots.map((s) => s.name).sort();
check('四个插槽都注册', slotNames.length === 4, JSON.stringify(slotNames));
check('含 main', slotNames.includes('main'));
check('含 sidebar.panellist', slotNames.includes('sidebar.panellist'));
check('含 header utilities', slotNames.includes('conversation.session.header.utilities'));
check('含 shell.overlay', slotNames.includes('shell.overlay'));
check('快捷键 effect 注册', captured.effects >= 1, String(captured.effects));

// ---- 2) 查找条渲染：busy=true 时计数 '…'
const overlay = captured.slots.find((s) => s.name === 'shell.overlay');
const overlayReg = overlay.cb();
const FindBar = overlayReg.comp;
check('overlay 注册的是组件', typeof FindBar === 'function');

// state 顺序：open, query, index, total, revision, wholeTotal, wholeIndex, busy
setQueue([true, 'symbol', 1, 3, 0, 12, 12, 2, true]);  // open,query,index,total,revision,wholeTotal,wholeShown,wholeIndex,busy
const tree = FindBar({ t: (k, a) => (a && a.count !== undefined ? `${k}:${a.count}` : k), loadThrough: () => Promise.resolve(), findSessionId: () => 's1' });

function findByClass(node, cls, out = []) {
  if (!node || typeof node !== 'object') return out;
  const cn = node.props && node.props.className;
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) out.push(node);
  for (const c of node.children || []) findByClass(c, cls, out);
  return out;
}

const counters = findByClass(tree, 'ssv-findCount');
check('有计数元素', counters.length === 1, String(counters.length));
check('busy 时显示 …', counters[0] && counters[0].children[0] === '…', JSON.stringify(counters[0] && counters[0].children));
check('busy 时 aria-busy=true', counters[0] && counters[0].props['aria-busy'] === 'true', JSON.stringify(counters[0] && counters[0].props));

// ---- 3) 非 busy：显示 n/总，且用索引总数
setQueue([true, 'symbol', 1, 3, 0, 12, 12, 2, false]);
const tree2 = FindBar({ t: (k, a) => (a && a.count !== undefined ? `${k}:${a.count}` : k), loadThrough: () => Promise.resolve(), findSessionId: () => 's1' });
const counters2 = findByClass(tree2, 'ssv-findCount');
check('非 busy 显示 3/12', counters2[0] && counters2[0].children[0] === '3/12', JSON.stringify(counters2[0] && counters2[0].children));
check('计数标题用索引总数', counters2[0] && counters2[0].props.title === 'find.whole:12', JSON.stringify(counters2[0] && counters2[0].props.title));

// ---- 4) 结果为空时按钮禁用
setQueue([true, 'zzz', -1, 0, 0, 0, 0, -1, false]);
const tree3 = FindBar({ t: (k) => k, loadThrough: () => Promise.resolve(), findSessionId: () => 's1' });
const buttons = findByClass(tree3, 'ssv-findBtn');
check('空结果时上/下按钮禁用', buttons[0].props.disabled === true && buttons[1].props.disabled === true, JSON.stringify(buttons.map((b) => b.props.disabled)));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
