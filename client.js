window.__ModuleLoader__.load({
  id: 'dsh-session-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'dsh-session-search';
    const PANEL_ID = NS;
    // 从会话页顶部入口打开时记住是哪个会话，供“当前会话”范围使用。
    let lastActiveSessionId;

    // 会话内查找条（不跳转页面）：模块级开关 + 订阅。
    let findOpen = false;
    // 从结果页点进来时先填这个关键词，再交给查找条自己算命中。
    let findSeededQuery = '';
    // { hint }：等命中算完，挑与这条命中 snippet 最吻合的那一处并滚过去。
    let pendingReveal = null;
    const findSubs = new Set();
    const notifyFind = () => { for (const fn of findSubs) fn(); };
    const subscribeFind = (fn) => { findSubs.add(fn); return () => { findSubs.delete(fn); }; };
    const HL_START = '\uFDD0';
    const HL_END = '\uFDD1';

    // 每条会话的逐条命中来自 host 侧同源路由（官方网关只返回每会话一条）。
    const HIT_ROUTE = '/ssv-search/events';
    // 子会话 id 与归档 id 也只有 host 侧知道。
    const STATE_ROUTE = '/ssv-search/state';
    // 路由不存在（旧版 host）时记一次，之后不再白试。两条路由各自记账，
    // 免得 /state 缺失把逐条命中一起关掉。
    let hitRouteAvailable = true;
    let stateRouteAvailable = true;

    const readPref = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem('ssv:' + key);
        return raw === null ? fallback : raw;
      } catch (_) { return fallback; }
    };
    const writePref = (key, value) => {
      try { window.localStorage.setItem('ssv:' + key, String(value)); } catch (_) { /* 隐私模式 */ }
    };

    const plainSnippet = (text) => String(text || '')
      .replaceAll(HL_START, '')
      .replaceAll(HL_END, '')
      .replace(/\s+/gu, ' ')
      .trim();

    // 用 snippet 的上下文给候选命中打分：把 hint 切成 6 字滑窗，数落在哪一段文字里最多。
    const contextScore = (el, hint) => {
      if (!el || !hint) return 0;
      const text = String(el.textContent || '').replace(/\s+/gu, ' ');
      if (text.length === 0) return 0;
      let score = 0;
      for (let i = 0, steps = 0; i + 6 <= hint.length && steps < 80; i += 3, steps += 1) {
        if (text.includes(hint.slice(i, i + 6))) score += 1;
      }
      return score;
    };

    const rowOf = (node) => {
      const el = node && node.parentElement;
      if (!el) return null;
      return (el.closest && el.closest('[data-chat-anchor-key]')) || el;
    };

    // 命中在页面上可能有很多处，挑与这条结果 snippet 上下文最接近的一处。
    function pickBestMatch(matches, hint) {
      if (!matches.length) return -1;
      if (matches.length === 1 || !hint) return 0;
      let best = 0;
      let bestScore = -1;
      for (let i = 0; i < matches.length; i += 1) {
        const score = contextScore(rowOf(matches[i].node), hint);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      return best;
    }

    // snippet 里第一个被 FTS 标记包住的词，就是这条命中的原词，拿来当查找条关键词最准。
    function matchedNeedle(snippet) {
      const text = String(snippet || '');
      const start = text.indexOf(HL_START);
      if (start === -1) return '';
      const end = text.indexOf(HL_END, start + 1);
      return end === -1 ? '' : text.slice(start + 1, end);
    }

    /**
     * 结果页可见性：子会话（subagent）与归档会话默认不出现在结果里。
     * 两者的 id 名单来自 host 侧 /state（客户端拿不到 origin 与归档标记）。
     */
    function filterByIdentity(rows, known, includeSubagent, includeArchived) {
      if (includeSubagent && includeArchived) return rows;
      const subagent = (known && known.subagent) || new Set();
      const archived = (known && known.archived) || new Set();
      return rows.filter((row) => (
        (includeSubagent || !subagent.has(row.sessionId))
        && (includeArchived || !archived.has(row.sessionId))
      ));
    }

    /**
     * 逐条命中：官方网关每场只返回一条 bestMatch，event 级结果只能走 host 侧
     * 只读路由（同一份 FTS 索引，一条 MATCH 几毫秒）。路由不存在时静默退回旧行为。
     */
    async function fetchSessionHits(query, ids, perSession, includeTools, signal) {
      // ids 为空 = 让 host 自己去索引里挑命中的会话（前缀兜底用）。
      if (!hitRouteAvailable) return null;
      const params = new URLSearchParams({
        q: query,
        ids: ids.join(','),
        perSession: String(perSession),
        tools: includeTools ? '1' : '0',
      });
      try {
        const res = await window.fetch(HIT_ROUTE + '?' + params.toString(), {
          signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          if (res.status === 404) hitRouteAvailable = false;
          return null;
        }
        // 路由没注册时，未知路径可能被 SPA 回退成 index.html（200 + HTML），解析失败就当不可用。
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) {
          hitRouteAvailable = false;
          return null;
        }
        if (!data || typeof data !== 'object' || data.error) return null;
        return data;
      } catch (_) {
        return null;
      }
    }

    /**
     * 哪些会话是子会话、哪些被归档：两者都只有 host 侧知道（`persisted_sessions.parent_session`
     * 与工作区注册表里的 archivedSessionIds），所以从同一条路由拿一次，缓存在模块里。
     * 拿不到时返回空集合 —— 那时无法过滤，宁可多给结果也不丢。
     */
    const identity = { subagent: new Set(), archived: new Set(), at: 0, tried: false };

    async function loadIdentity(signal) {
      if (!stateRouteAvailable) return identity;
      // 子会话/归档名单变化很慢，30 秒内复用，别每次敲字都拉一遍。
      if (identity.tried && Date.now() - identity.at < 30000) return identity;
      try {
        const res = await window.fetch(STATE_ROUTE, { signal, headers: { accept: 'application/json' } });
        if (!res.ok) {
          if (res.status === 404) stateRouteAvailable = false;
          return identity;
        }
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) { stateRouteAvailable = false; return identity; }
        if (!data || typeof data !== 'object' || data.error) return identity;
        identity.subagent = new Set(Array.isArray(data.subagent) ? data.subagent : []);
        identity.archived = new Set(Array.isArray(data.archived) ? data.archived : []);
        identity.at = Date.now();
        identity.tried = true;
      } catch (_) {
        /* 路由不在或请求被取消：保持上一份快照 */
      }
      return identity;
    }

    const zh = {
      'meta.title': '会话全文搜索',
      'meta.description': '本地搜索会话记录，支持“当前会话 / 全部历史会话”范围，点击结果定位到原会话。',
      'panel': '会话全文搜索',
      'title': '会话全文搜索',
      'subtitle': '本地匹配会话记录，不区分模型',
      'placeholder': '输入关键词搜索会话记录',
      'searching': '搜索中…',
      'empty': '输入关键词开始搜索',
      'noResults': '没有匹配的会话记录',
      'noResultsHint': '换个更短的词、掐掉词尾（symbo → symbol），或勾选“含子会话 / 含归档”再试。',
      'titleMatch': '标题匹配',
      'more': '仅显示部分结果，请缩小搜索范围。',
      'error': '搜索失败：{message}',
      'back': '返回对话',
      'find.placeholder': '在当前会话中查找',
      'find.prev': '上一个（Shift+Enter）',
      'find.next': '下一个（Enter）',
      'find.close': '关闭（Esc）',
      'hits': '{count} 处',
      'hits.show': '展开 {count} 处命中',
      'hits.hide': '收起命中',
      'hits.perSession': '每会话',
      'hits.tools': '含工具输出',
      'hits.subagent': '含子会话',
      'hits.subagentHint': '子代理（subagent）产生的会话；默认不显示，它们通常只是中间过程',
      'hits.archived': '含归档',
      'hits.archivedHint': '已归档的会话；默认不显示，它们不在侧栏里',
      'prefixNote': '整词没有命中，已按前缀匹配（例如 symbo → symbol）',
      'help.toggle': '搜索说明：怎么搜才准',
      'help.whole': '按整词匹配。搜 symbol 能命中 symbol / 带 symbol 的词组；搜 symbo 会先当整词试，没有结果再自动按前缀找（→ symbol、symbolic）。',
      'help.prefix': '前缀只从词首算：mbol 搜不到 symbol。想找中间片段，换用更靠前的部分或另一个显著词。',
      'help.tokens': '多个词用空格分开，要求全部命中（AND），例如“缓存 清理”。标点、引号按普通字符处理。',
      'help.cjk': '中文按连续字串匹配，例如“缓存”能命中“缓存命中”；英文不区分大小写。',
      'help.scope': '“含子会话 / 含归档”默认关闭：子代理跑的会话、已归档的会话不进结果，需要时自己勾上。按 ⌘⇧F（Ctrl+Shift+F）随时打开本页，Esc 返回。',
      'hint.findInSession': '只想在当前这场会话里找？在会话页按 ⌘F（Ctrl+F），查找条同样覆盖整段对话。',
      'find.whole': '全对话 {count} 处',
      'find.old': '较旧的命中会按需加载历史',
      'hits.user': '你',
      'hits.assistant': 'AI',
      'hits.tool': '工具',
      'hits.other': '记录',
    };
    const en = {
      'meta.title': 'Session full-text search',
      'meta.description': 'Locally search every session record, with click-to-locate results.',
      'panel': 'Session search',
      'title': 'Session full-text search',
      'subtitle': 'Matches local session records, model-independent',
      'placeholder': 'Type a keyword to search session records',
      'searching': 'Searching…',
      'empty': 'Type a keyword to start searching',
      'noResults': 'No matching session records',
      'noResultsHint': 'Try a shorter or earlier fragment (symbo → symbol), or tick “sub-agent / archived”.',
      'titleMatch': 'Title match',
      'more': 'Only part of the results is shown. Narrow your search.',
      'error': 'Search failed: {message}',
      'back': 'Back to conversation',
      'find.placeholder': 'Find in this session',
      'find.prev': 'Previous (Shift+Enter)',
      'find.next': 'Next (Enter)',
      'find.close': 'Close (Esc)',
      'hits': '{count} hits',
      'hits.show': 'Show {count} hits',
      'hits.hide': 'Hide hits',
      'hits.perSession': 'Per session',
      'hits.tools': 'Include tool output',
      'hits.subagent': 'Include subagent sessions',
      'hits.subagentHint': 'Sessions produced by subagents; hidden by default because they are usually intermediate work',
      'hits.archived': 'Include archived',
      'hits.archivedHint': 'Archived sessions; hidden by default because they are not in the sidebar',
      'prefixNote': 'No whole-word match; showing prefix matches (symbo → symbol)',
      'help.toggle': 'Search tips: how to match',
      'help.whole': 'Whole-word matching. symbol finds symbol and words built on it; symbo is tried as a whole word first, then as a prefix (→ symbol, symbolic).',
      'help.prefix': 'A prefix only counts from the start of a word: mbol will not find symbol. Use an earlier fragment or another distinctive word.',
      'help.tokens': 'Separate words with spaces; all of them must match (AND), e.g. "cache cleanup". Punctuation and quotes are plain characters.',
      'help.cjk': 'CJK text matches as a contiguous string, so 缓存 finds 缓存命中. Latin text is case-insensitive.',
      'help.scope': 'Sub-agent and archived sessions are excluded by default; tick the boxes when you want them. ⌘⇧F (Ctrl+Shift+F) opens this page from anywhere, Esc goes back.',
      'hint.findInSession': 'Looking inside the open session only? Press ⌘F (Ctrl+F) there — the find bar covers the whole conversation too.',
      'find.whole': '{count} in whole conversation',
      'find.old': 'Older hits page history in on demand',
      'hits.user': 'You',
      'hits.assistant': 'AI',
      'hits.tool': 'Tool',
      'hits.other': 'Record',
    };

    const CSS = `
.ssv-page{box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;flex-direction:column;overflow:hidden}
.ssv-scroll{scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;flex:1;min-height:0;overflow:auto}
.ssv-content{max-width:760px;margin:0 auto;padding:0 clamp(20px,4vw,40px) 48px}
.ssv-head{padding-top:24px;margin-bottom:18px}
[data-platform=darwin] .ssv-head{padding-top:calc(24px + var(--dsh-frame-top-clearance,0px))}
.ssv-head h1{margin:0;font-size:20px;font-weight:600;line-height:28px}
.ssv-head p{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ssv-back{display:inline-flex;align-items:center;gap:4px;height:28px;margin-bottom:12px;padding:0 8px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;background:0 0;border:0;border-radius:8px}
.ssv-back:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ssv-field{box-sizing:border-box;display:flex;align-items:center;height:38px;margin:0 0 14px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;transition:border-color .15s}
.ssv-field:hover{border-color:var(--dsw-alias-border-l2)}
.ssv-field:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.ssv-input{flex:1;min-width:0;height:100%;color:var(--dsw-alias-label-primary);font:inherit;background:0 0;border:0;outline:0;padding:0}
.ssv-input::placeholder{color:var(--dsw-alias-label-caption)}
.ssv-input:focus-visible{outline:none}
.ssv-status{min-height:20px;margin:0 0 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.ssv-current{margin:-8px 0 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}
.ssv-current b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.ssv-headerBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-radius:6px;cursor:pointer;transition:color .12s}
.ssv-headerBtn:hover,.ssv-headerBtn:focus-visible{color:var(--dsw-alias-label-primary);background:0 0;outline:0}
.ssv-find{position:fixed;top:calc(54px + var(--dsh-frame-top-clearance,0px));right:22px;z-index:70;display:flex;align-items:center;gap:4px;padding:6px 6px 6px 8px;border-radius:12px;background:var(--dsw-alias-bg-raised,var(--dsw-alias-bg-base));border:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-mid,0 10px 28px rgba(0,0,0,.32))}
.ssv-findInput{box-sizing:border-box;width:210px;height:28px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;outline:0}
.ssv-findInput:focus{border-color:var(--dsw-alias-state-business-primary)}
.ssv-findCount{min-width:46px;padding:0 2px;text-align:right;font-size:12px;line-height:24px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ssv-findBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-secondary);background:0 0;border:0;border-radius:6px;cursor:pointer}
.ssv-findBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ssv-findBtn:disabled{opacity:.35;cursor:default}
.ssv-findLayer{position:fixed;inset:0;z-index:69;pointer-events:none}
.ssv-findMark{position:absolute;border-radius:2px;background:rgba(255,196,0,.34);box-shadow:0 0 0 1px rgba(255,196,0,.30);pointer-events:none}
.ssv-findMark[data-current=true]{background:rgba(255,148,0,.85);box-shadow:0 0 0 1px rgba(255,120,0,.85)}
.ssv-mark{border-radius:2px;background:rgba(255,196,0,.30);color:inherit}
.ssv-error{color:var(--dsw-alias-state-error-primary)}
.ssv-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.ssv-row{display:block;width:100%;text-align:left;padding:11px 13px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);transition:background-color .12s,border-color .12s}
.ssv-row:hover,.ssv-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.ssv-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.ssv-rowHead{display:flex;align-items:baseline;gap:8px;min-width:0}
.ssv-rowTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;line-height:21px;color:var(--dsw-alias-label-primary)}
.ssv-rowTime{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ssv-rowSnippet{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.ssv-rowSnippet .ssv-tag{margin-right:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ssv-empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:48px 20px;font-size:14px}
.ssv-empty p{margin:0}
.ssv-emptyHint{margin-top:8px !important;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.ssv-empty .ssv-helpToggle{margin-top:10px}
.ssv-more{margin:14px 0 0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.ssv-rowWrap{display:flex;flex-direction:column;gap:2px}
.ssv-rowCount{align-self:flex-start;margin-top:6px;padding:0 7px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ssv-hitsToggle{align-self:flex-start;margin-left:3px;padding:2px 6px;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:0;border-radius:7px}
.ssv-hitsToggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ssv-hits{display:flex;flex-direction:column;gap:2px;margin:2px 0 8px 12px;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l1)}
.ssv-hit{display:block;width:100%;padding:5px 7px;text-align:left;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border:0;border-radius:8px}
.ssv-hit:hover,.ssv-hit:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.ssv-hitMeta{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ssv-hitSnippet{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.ssv-hit:hover .ssv-hitSnippet{color:var(--dsw-alias-label-primary)}
.ssv-helpWrap{margin:0 0 12px}
.ssv-helpToggle{padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;background:0 0;border:0;cursor:pointer}
.ssv-helpToggle:hover{color:var(--dsw-alias-label-primary)}
.ssv-help{margin:6px 0 0;padding:10px 12px 10px 26px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}
.ssv-help li{margin:0 0 4px}
.ssv-help li:last-child{margin-bottom:0}
.ssv-note{margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ssv-prefs{display:flex;align-items:center;gap:14px;margin:-4px 0 14px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ssv-prefs label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.ssv-prefs select{height:24px;padding:0 6px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;outline:0}
.ssv-prefs input[type=checkbox]{margin:0;accent-color:var(--dsw-alias-state-business-primary)}
`;

    function Styles() { return h('style', null, CSS); }

    function SearchIcon({ size }) {
      return h('svg', {
        width: size || 18, height: size || 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M20 20l-4-4' })
      );
    }

    function SearchHeaderButton({ sessionId, t }) {
      return h(React.Fragment, null,
        h(Styles),
        h('button', {
          type: 'button', className: 'ssv-headerBtn',
          title: t('panel'), 'aria-label': t('panel'),
          onClick: () => { lastActiveSessionId = sessionId; findOpen = !findOpen; notifyFind(); },
        }, h(SearchIcon, { size: 16 }))
      );
    }

    function Glyph({ d }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        style: { display: 'block' },
      }, h('path', { d }));
    }

    // 命中高亮不用 CSS Custom Highlight API（Electron 版本差异会让它静默失效），
    // 改成"固定定位色块层"覆盖在文字上方：位置来自 Range.getClientRects()，滚动时重算。
    function paintMatches(layer, matches, current) {
      if (!layer) return;
      layer.textContent = '';
      if (!matches || !matches.length) return;
      // 以层自身为坐标原点：即使上层容器有 transform（会改变 fixed 定位的参照物），
      // 用相对位移算的色块也不会错位。
      let base = { left: 0, top: 0, bottom: (window.innerHeight || 0) };
      try { base = layer.getBoundingClientRect(); } catch { /* 保底用视口 */ }
      // 只画落在会话滚动区可见范围内的块：色块是 fixed 定位，不裁会画到 composer / 标题栏上。
      let clip = { top: base.top, bottom: base.bottom, left: base.left, right: base.left + base.width };
      try {
        const scroller = document.querySelector('[data-conversation-scroll]');
        if (scroller) {
          const s = scroller.getBoundingClientRect();
          clip = {
            top: Math.max(clip.top, s.top),
            bottom: Math.min(clip.bottom, s.bottom),
            left: Math.max(clip.left, s.left),
            right: Math.min(clip.right, s.right),
          };
        }
      } catch (_) { /* 拿不到滚动区就按视口裁 */ }
      const frag = document.createDocumentFragment();
      const limit = Math.min(matches.length, 500);
      for (let i = 0; i < limit; i += 1) {
        let rects = [];
        try { rects = matches[i].range.getClientRects(); } catch { rects = []; }
        for (let r = 0; r < rects.length; r += 1) {
          const rect = rects[r];
          if (!rect || rect.width < 1 || rect.height < 1) continue;
          if (rect.bottom <= clip.top || rect.top >= clip.bottom) continue;
          if (rect.right <= clip.left || rect.left >= clip.right) continue;
          const mark = document.createElement('div');
          mark.className = 'ssv-findMark';
          if (i === current) mark.dataset.current = 'true';
          mark.style.left = rect.left - base.left + 'px';
          mark.style.top = rect.top - base.top + 1 + 'px';
          mark.style.width = rect.width + 'px';
          mark.style.height = Math.max(2, rect.height - 2) + 'px';
          frag.appendChild(mark);
        }
      }
      layer.appendChild(frag);
    }

    function collectMatches(root, needle) {
      const out = [];
      if (!root || !needle) return out;
      const lower = needle.toLowerCase();
      // content-visibility:hidden 的元素 checkVisibility 判不出来（它只管 auto），
      // 单独按计算样式往上找一次，结果按元素缓存，避免每个文本节点都重算。
      const hiddenCache = new Map();
      const hiddenByStyle = (el) => {
        if (hiddenCache.has(el)) return hiddenCache.get(el);
        let cur = el;
        let hidden = false;
        while (cur && cur !== document.body && cur !== document.documentElement) {
          if (hiddenCache.has(cur)) { hidden = hiddenCache.get(cur); break; }
          let cs = null;
          try { cs = window.getComputedStyle(cur); } catch (_) { cs = null; }
          if (cs && (cs.contentVisibility === 'hidden' || cs.visibility === 'hidden' || cs.display === 'none')) { hidden = true; break; }
          cur = cur.parentElement;
        }
        hiddenCache.set(el, hidden);
        return hidden;
      };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = node.nodeValue;
          if (!value || !value.trim()) return NodeFilter.FILTER_SKIP;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_SKIP;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT') return NodeFilter.FILTER_SKIP;
          if (parent.closest('.ssv-find')) return NodeFilter.FILTER_SKIP;
          // 输入框（composer）也挂在滚动容器里，别把草稿文字算进结果。
          if (parent.closest('[data-composer-seat], [data-conversation-region="composer"], [contenteditable="true"]')) return NodeFilter.FILTER_SKIP;
          // 收起的步骤/思考行是 hidden="until-found"：浏览器为了 find-in-page 仍给它们排版并返回
          // rect，但它们并不绘制。不排除就会在页面上画出"对不上字"的色块。
          // 注意不能按 aria-hidden 过滤：ChatView 给非当前轮次的消息也挂了 aria-hidden，那是可见内容。
          if (parent.closest('[hidden]')) return NodeFilter.FILTER_SKIP;
          // content-visibility:hidden / visibility:hidden / opacity:0 同理（Chromium 的 checkVisibility 一次判完）。
          try {
            if (typeof parent.checkVisibility === 'function'
              && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) {
              return NodeFilter.FILTER_SKIP;
            }
          } catch (_) { /* 老版本没有 checkVisibility 就只靠上面的属性判断 */ }
          if (hiddenByStyle(parent)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const hay = node.nodeValue.toLowerCase();
        let at = hay.indexOf(lower);
        while (at !== -1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          out.push({ range, node });
          at = hay.indexOf(lower, at + needle.length);
        }
        if (out.length > 800) break;
      }
      return out;
    }

    function revealMatch(match) {
      const el = match && match.node ? match.node.parentElement : null;
      if (!el || typeof el.scrollIntoView !== 'function') return;
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
    }

    function FindBar({ t, loadThrough, findSessionId }) {
      const [open, setOpen] = useState(findOpen);
      const [query, setQuery] = useState('');
      const [index, setIndex] = useState(-1);
      const [total, setTotal] = useState(0);
      const [revision, setRevision] = useState(0);
      // 整段对话（不只是已加载的 DOM）的命中共有多少条，用来给计数兜底。
      const [wholeTotal, setWholeTotal] = useState(0);
      const [wholeIndex, setWholeIndex] = useState(-1);
      const wholeHitsRef = useRef([]);
      const wholeIndexRef = useRef(-1);
      const matchesRef = useRef([]);
      const indexRef = useRef(-1);
      const lastQueryRef = useRef(null);
      const inputRef = useRef(null);
      const layerRef = useRef(null);

      useEffect(() => subscribeFind(() => {
        setOpen(findOpen);
        if (!findOpen) { setQuery(''); pendingReveal = null; return; }
        // 从全局结果页跳进来：先填好关键词，交给下面的重算 effect 找命中。
        if (findSeededQuery) {
          const seeded = findSeededQuery;
          findSeededQuery = '';
          setQuery(seeded);
        }
        // 已经是打开状态时再按 ⌘F：不重建组件，只把焦点和已有关键词选中。
        const focusNow = () => {
          const el = inputRef.current;
          if (!el) return;
          try { el.focus(); el.select(); } catch (_) { /* 输入框还没挂上 */ }
        };
        focusNow();
        setTimeout(focusNow, 40);
      }), []);

      useEffect(() => {
        if (!open) {
          matchesRef.current = [];
          indexRef.current = -1;
          lastQueryRef.current = null;
          setTotal(0); setIndex(-1);
          if (layerRef.current) layerRef.current.textContent = '';
          return;
        }
        const focus = setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 0);
        return () => clearTimeout(focus);
      }, [open]);

      // 会话切换 / 历史加载 / 流式输出都会改写消息 DOM：观察到变化就重算计数，
      // 否则切换会话后条数会停在上一场。滚动容器本身常被 React 复用，所以监听 body。
      useEffect(() => {
        if (!open) return;
        let timer = 0;
        const observer = new MutationObserver((records) => {
          const relevant = records.some((record) => {
            const node = record.target;
            const el = node && node.nodeType === 1 ? node : (node && node.parentElement);
            return !(el && el.closest && el.closest('.ssv-findLayer, .ssv-find'));
          });
          if (!relevant) return;
          clearTimeout(timer);
          timer = setTimeout(() => setRevision((v) => v + 1), 300);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return () => { observer.disconnect(); clearTimeout(timer); };
      }, [open]);

      useEffect(() => {
        if (!open) return;
        const needle = query.trim();
        let settle = 0;
        const timer = setTimeout(() => {
          const root = document.querySelector('[data-conversation-scroll]');
          const matches = collectMatches(root, needle);
          const prev = indexRef.current;
          let next = matches.length === 0 ? -1 : (prev < 0 ? 0 : Math.min(prev, matches.length - 1));
          let jump = false;
          // 从结果页跳进来时，等页面换到目标会话、命中落到正确位置再滚；还没加载到就等下一次重算。
          if (matches.length > 0 && pendingReveal) {
            const best = pickBestMatch(matches, pendingReveal.hint);
            const strong = pendingReveal.hint === '' || contextScore(rowOf(matches[best].node), pendingReveal.hint) > 0;
            if (strong || pendingReveal.attempts >= 4) {
              next = best;
              jump = true;
              pendingReveal = null;
            } else {
              pendingReveal.attempts += 1;
            }
          }
          const changed = lastQueryRef.current !== needle;
          lastQueryRef.current = needle;
          matchesRef.current = matches;
          indexRef.current = next;
          setTotal(matches.length);
          setIndex(next);
          paintMatches(layerRef.current, matches, next);
          // 只有关键词变了（或从结果页指定了落点）才把视图拉过去；流式/切会话引起的重算不动视口。
          if ((changed || jump) && next >= 0) revealMatch(matches[next]);
          // 懒加载 / 代码块 / 图片落位会把文字推走，落定后再画一次。
          clearTimeout(settle);
          settle = setTimeout(() => {
            paintMatches(layerRef.current, matchesRef.current, indexRef.current);
          }, 320);
        }, 140);
        return () => { clearTimeout(timer); clearTimeout(settle); };
      }, [open, query, revision]);

      // 整段对话范围：DOM 里只有已加载的那一页消息，更早的命中在 FTS 索引里。
      // 计数以索引为准，翻页靠 loadThrough(seq) 把历史拉回来再在 DOM 上定位。
      useEffect(() => {
        if (!open) return;
        const needle = query.trim();
        const sid = findSessionId ? findSessionId() : undefined;
        if (!needle || !sid) {
          wholeHitsRef.current = [];
          wholeIndexRef.current = -1;
          setWholeTotal(0);
          setWholeIndex(-1);
          return;
        }
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(async () => {
          const data = await fetchSessionHits(needle, [sid], 200, false, ac ? ac.signal : undefined);
          if (!data || (ac && ac.signal.aborted)) return;
          const list = (data.hits || []).filter((hit) => hit.sessionId === sid).sort((a, b) => a.seq - b.seq);
          wholeHitsRef.current = list;
          wholeIndexRef.current = -1;
          setWholeIndex(-1);
          setWholeTotal(Number((data.counts && data.counts[sid]) || list.length));
        }, 220);
        return () => { clearTimeout(timer); if (ac) ac.abort(); };
      }, [open, query, findSessionId]);

      // 色块是固定定位的，页面一滚就错位，跟着重画。
      useEffect(() => {
        if (!open) return;
        let raf = 0;
        const repaint = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            paintMatches(layerRef.current, matchesRef.current, indexRef.current);
          });
        };
        window.addEventListener('scroll', repaint, true);
        window.addEventListener('resize', repaint);
        return () => {
          window.removeEventListener('scroll', repaint, true);
          window.removeEventListener('resize', repaint);
          if (raf) cancelAnimationFrame(raf);
        };
      }, [open]);

      const close = useCallback(() => { findOpen = false; notifyFind(); }, []);

      // 跳到整段对话里的第 i 条：先把那条事件所在的历史页加载回来，再在 DOM 上定位。
      const jumpWhole = useCallback(async (i) => {
        const list = wholeHitsRef.current;
        if (!list.length) return;
        const hit = list[(i + list.length) % list.length];
        wholeIndexRef.current = i;
        setWholeIndex(i);
        if (hit && hit.seq) {
          try { await loadThrough(hit.seq); } catch (_) { /* 加载失败就只按当前 DOM 定位 */ }
        }
        // 等新加载的那页消息挂进 DOM
        await new Promise((resolve) => { setTimeout(resolve, 240); });
        const needle = query.trim();
        const root = document.querySelector('[data-conversation-scroll]');
        const matches = collectMatches(root, needle);
        matchesRef.current = matches;
        const best = pickBestMatch(matches, plainSnippet(hit && hit.snippet));
        indexRef.current = best;
        setTotal(matches.length);
        setIndex(best);
        paintMatches(layerRef.current, matches, best);
        if (best >= 0) revealMatch(matches[best]);
      }, [loadThrough, query]);

      const step = useCallback((dir) => {
        const whole = wholeHitsRef.current;
        if (whole.length > 0) {
          const cur = wholeIndexRef.current;
          jumpWhole(cur < 0 ? (dir > 0 ? 0 : whole.length - 1) : (cur + dir + whole.length) % whole.length);
          return;
        }
        const matches = matchesRef.current;
        if (!matches.length) return;
        const cur = indexRef.current;
        const next = cur < 0 ? (dir > 0 ? 0 : matches.length - 1) : (cur + dir + matches.length) % matches.length;
        indexRef.current = next;
        setIndex(next);
        paintMatches(layerRef.current, matches, next);
        revealMatch(matches[next]);
      }, [jumpWhole]);

      if (!open) return null;

      // 索引里的总数才是"整段对话"的真实命中数；DOM 里的可能只是已加载的部分。
      const shownTotal = wholeTotal > total ? wholeTotal : total;
      const shownIndex = wholeTotal > total ? (wholeIndex >= 0 ? wholeIndex + 1 : 1) : (index >= 0 ? index + 1 : 1);
      const counter = shownTotal ? shownIndex + '/' + shownTotal : '0/0';

      return h(React.Fragment, null, h(Styles),
        h('div', { className: 'ssv-findLayer', ref: layerRef, 'aria-hidden': true }),
        h('div', { className: 'ssv-find', role: 'search' },
        h('input', {
          ref: inputRef, type: 'text', className: 'ssv-findInput', value: query,
          placeholder: t('find.placeholder'), 'aria-label': t('find.placeholder'),
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
          },
        }),
        h('span', {
          className: 'ssv-findCount',
          title: wholeTotal > total ? t('find.whole', { count: wholeTotal }) : undefined,
        }, counter),
        h('button', { type: 'button', className: 'ssv-findBtn', title: t('find.prev'), 'aria-label': t('find.prev'), disabled: shownTotal === 0, onClick: () => step(-1) }, h(Glyph, { d: 'M18 15l-6-6-6 6' })),
        h('button', { type: 'button', className: 'ssv-findBtn', title: t('find.next'), 'aria-label': t('find.next'), disabled: shownTotal === 0, onClick: () => step(1) }, h(Glyph, { d: 'M6 9l6 6 6-6' })),
        h('button', { type: 'button', className: 'ssv-findBtn', title: t('find.close'), 'aria-label': t('find.close'), onClick: close }, h(Glyph, { d: 'M6 6l12 12M18 6L6 18' }))
      ));
    }

    // 结果页 snippet 里命中词被 FTS 用两个非字符包着（\uFDD0 / \uFDD1），转成 <mark>。
    function splitSnippet(text) {
      const parts = [];
      let rest = text || '';
      let key = 0;
      while (rest.length) {
        const start = rest.indexOf(HL_START);
        const endOnly = rest.indexOf(HL_END);
        if (start === -1 && endOnly === -1) { parts.push(h('span', { key: key++ }, rest)); break; }
        if (start === -1 || (endOnly !== -1 && endOnly < start)) {
          if (endOnly > 0) parts.push(h('span', { key: key++ }, rest.slice(0, endOnly)));
          rest = rest.slice(endOnly + 1);
          continue;
        }
        if (start > 0) parts.push(h('span', { key: key++ }, rest.slice(0, start)));
        const close = rest.indexOf(HL_END, start + 1);
        if (close === -1) { parts.push(h('mark', { key: key++, className: 'ssv-mark' }, rest.slice(start + 1))); break; }
        parts.push(h('mark', { key: key++, className: 'ssv-mark' }, rest.slice(start + 1, close)));
        rest = rest.slice(close + 1);
      }
      return parts;
    }

    function formatTime(ms) {
      if (!ms) return '';
      try {
        return new Intl.DateTimeFormat(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(new Date(ms));
      } catch (_) { return String(ms); }
    }

    function SearchPanel(props) {
      const { search, listSnapshot, currentSessionId, sessionTitle, sessionTime, openSession, close, revealHit, t } = props;
      const [query, setQuery] = useState('');
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [hasMore, setHasMore] = useState(false);
      // sessionId → 该会话全部命中（逐条，来自 host 路由）
      const [hits, setHits] = useState({});
      const [counts, setCounts] = useState({});
      const [expanded, setExpanded] = useState({});
      const [perSession, setPerSession] = useState(() => Number(readPref('perSession', 3)) || 3);
      const [includeTools, setIncludeTools] = useState(() => readPref('tools', '0') === '1');
      // 子会话（subagent）与归档会话默认不出现在结果里：全局范围下它们占了索引的很大一块噪音。
      const [includeSubagent, setIncludeSubagent] = useState(() => readPref('subagent', '0') === '1');
      const [includeArchived, setIncludeArchived] = useState(() => readPref('archived', '0') === '1');
      // 整词没命中、退回前缀匹配时给一行提示，免得用户以为搜的是子串。
      const [prefixNote, setPrefixNote] = useState(false);
      // 搜索说明默认展开，收起状态记在偏好里。
      const [helpOpen, setHelpOpen] = useState(() => readPref('help', '1') === '1');
      const toggleHelp = () => {
        const next = !helpOpen;
        setHelpOpen(next);
        writePref('help', next ? '1' : '0');
      };
      const inputRef = useRef(null);

      useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

      // Esc 退出搜索页，回到进入之前的页面（等同左上角"返回对话"）。
      // 查找条开着时让给查找条自己的 Esc 处理，输入法组字中也不插手。
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape' || event.isComposing) return;
          if (typeof document.querySelector === 'function' && document.querySelector('.ssv-find')) return;
          event.preventDefault();
          close();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [close]);

      const changePerSession = (value) => {
        const next = Math.min(Math.max(Number(value) || 3, 1), 12);
        setPerSession(next);
        writePref('perSession', next);
      };
      const changeTools = (value) => {
        setIncludeTools(value);
        writePref('tools', value ? '1' : '0');
      };
      const changeSubagent = (value) => {
        setIncludeSubagent(value);
        writePref('subagent', value ? '1' : '0');
      };
      const changeArchived = (value) => {
        setIncludeArchived(value);
        writePref('archived', value ? '1' : '0');
      };

      const run = useCallback(async (q, signal) => {
        const trimmed = q.trim();
        if (!trimmed) {
          setItems([]); setError(''); setLoading(false); setHasMore(false);
          setHits({}); setCounts({}); setExpanded({});
          setPrefixNote(false);
          return;
        }
        setLoading(true); setError('');
        try {
          const res = await search(trimmed, signal);
          if (signal.aborted) return;
          if (!res.ok) throw new Error((res.error && res.error.message) || 'search failed');
          const byId = new Map();
          for (const it of (res.value.items || [])) {
            if (!byId.has(it.sessionId)) {
              byId.set(it.sessionId, { sessionId: it.sessionId, snippet: it.snippet || '' });
            }
          }
          const lower = trimmed.toLowerCase();
          const list = listSnapshot();
          const byIdRows = (list && list.byId) || {};
          const ids = (list && list.ids) || Object.keys(byIdRows);
          for (const id of ids) {
            const s = byIdRows[id];
            if (!s || s.blank) continue;
            const title = sessionTitle(id);
            if (String(title).toLowerCase().includes(lower)) {
              if (!byId.has(id)) byId.set(id, { sessionId: id, snippet: '' });
            }
          }
          let merged = Array.from(byId.values());
          const applyIdentity = async (rows) => {
            if (includeSubagent && includeArchived) return rows;
            const known = await loadIdentity(signal);
            return signal.aborted ? rows : filterByIdentity(rows, known, includeSubagent, includeArchived);
          };
          merged = await applyIdentity(merged);
          if (signal.aborted) return;
          // 网关是整词匹配（FTS token），"symbo" 这种半截词在它那里是空的。
          // 这时改用 host 路由做前缀匹配，一次把匹配的会话捞出来。
          let mode = 'exact';
          if (merged.length === 0) {
            const fallback = await fetchSessionHits(trimmed, [], 1, includeTools, signal);
            if (signal.aborted) return;
            if (fallback && Array.isArray(fallback.hits) && fallback.hits.length > 0) {
              const seen = new Set();
              merged = [];
              for (const hit of fallback.hits) {
                if (seen.has(hit.sessionId)) continue;
                seen.add(hit.sessionId);
                merged.push({ sessionId: hit.sessionId, snippet: hit.snippet || '' });
              }
              merged = await applyIdentity(merged);
              if (signal.aborted) return;
              mode = fallback.mode || 'prefix';
            }
          }
          setPrefixNote(mode === 'prefix');
          setItems(merged);
          setHasMore(!!res.value.hasMore);
          setExpanded({});
          // 官方网关每场只给一条最佳命中，逐条命中要靠同源路由补齐。
          const wanted = merged.slice(0, 40).map((it) => it.sessionId);
          if (wanted.length === 0 || !hitRouteAvailable) {
            setHits({}); setCounts({});
            return;
          }
          const data = await fetchSessionHits(trimmed, wanted, perSession, includeTools, signal);
          if (signal.aborted) return;
          if (data === null) { setHits({}); setCounts({}); return; }
          const grouped = {};
          for (const hit of data.hits || []) {
            (grouped[hit.sessionId] || (grouped[hit.sessionId] = [])).push(hit);
          }
          for (const list of Object.values(grouped)) list.sort((a, b) => a.seq - b.seq);
          setHits(grouped);
          setCounts(data.counts || {});
        } catch (e) {
          if (signal.aborted) return;
          setError(t('error', { message: (e && e.message) || '' }));
          setItems([]);
          setHits({}); setCounts({});
        } finally {
          if (!signal.aborted) setLoading(false);
        }
      }, [search, listSnapshot, sessionTitle, currentSessionId, t, perSession, includeTools, includeSubagent, includeArchived]);

      useEffect(() => {
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const signal = ac ? ac.signal : { aborted: false };
        const timer = setTimeout(() => { run(query, signal); }, 200);
        return () => { clearTimeout(timer); if (ac) ac.abort(); };
      }, [query, run]);

      const onOpen = (id) => { openSession(id); };

      let status = '';
      if (error) status = error;
      else if (loading) status = t('searching');

      const typeLabel = (type) => {
        if (type === 'user/message') return t('hits.user');
        if (type === 'assistant/message') return t('hits.assistant');
        if (type === 'tool/call' || type === 'tool/result') return t('hits.tool');
        return t('hits.other');
      };

      const toggleRow = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

      const listContent = (() => {
        if (query.trim() === '') {
          return h('div', { className: 'ssv-empty' },
            h('p', null, t('empty')),
            h('p', { className: 'ssv-emptyHint' }, t('hint.findInSession'))
          );
        }
        if (items.length === 0 && !loading && !error) {
          return h('div', { className: 'ssv-empty' },
            h('p', null, t('noResults')),
            h('p', { className: 'ssv-emptyHint' }, t('noResultsHint')),
            helpOpen
              ? null
              : h('button', { type: 'button', className: 'ssv-helpToggle', onClick: toggleHelp }, '▸ ' + t('help.toggle'))
          );
        }
        return h('div', { className: 'ssv-list' }, items.map((it) => {
          const title = sessionTitle(it.sessionId);
          const count = counts[it.sessionId] || 0;
          const rows = hits[it.sessionId] || [];
          const showHits = !!expanded[it.sessionId];
          return h('div', { key: it.sessionId, className: 'ssv-rowWrap' },
            h('button', {
              type: 'button', className: 'ssv-row',
              onClick: () => onOpen(it.sessionId),
              title: title || it.sessionId,
            },
              h('span', { className: 'ssv-rowHead' },
                h('span', { className: 'ssv-rowTitle' }, title || it.sessionId),
                h('span', { className: 'ssv-rowTime' }, formatTime(sessionTime(it.sessionId)))
              ),
              h('span', { className: 'ssv-rowSnippet' },
                it.snippet
                  ? splitSnippet(it.snippet)
                  : h(React.Fragment, null, h('span', { className: 'ssv-tag' }, t('titleMatch')))
              ),
              count > 0 ? h('span', { className: 'ssv-rowCount' }, t('hits', { count })) : null
            ),
            count > 0 ? h('button', {
              type: 'button', className: 'ssv-hitsToggle',
              onClick: () => toggleRow(it.sessionId),
            }, showHits ? t('hits.hide') : t('hits.show', { count })) : null,
            showHits && rows.length
              ? h('div', { className: 'ssv-hits' }, rows.map((hit, i) => h('button', {
                  type: 'button', key: it.sessionId + ':' + hit.seq + ':' + i, className: 'ssv-hit',
                  onClick: () => revealHit(it.sessionId, hit, query.trim()),
                  title: plainSnippet(hit.snippet),
                },
                  h('span', { className: 'ssv-hitMeta' },
                    typeLabel(hit.type),
                    hit.time ? ' · ' + formatTime(hit.time) : ''
                  ),
                  h('span', { className: 'ssv-hitSnippet' }, splitSnippet(hit.snippet))
                )))
              : null
          );
        }));
      })();

      return h(React.Fragment, null,
        h(Styles),
        h('div', { className: 'ssv-page' },
          h('div', { className: 'ssv-scroll' },
            h('div', { className: 'ssv-content' },
              h('button', { type: 'button', className: 'ssv-back', onClick: close }, '‹ ', t('back')),
              h('div', { className: 'ssv-head' },
                h('h1', null, t('title')),
                h('p', null, t('subtitle'))
              ),
              h('div', { className: 'ssv-field' },
                h('input', {
                  ref: inputRef, type: 'search', className: 'ssv-input',
                  placeholder: t('placeholder'), value: query,
                  onChange: (e) => setQuery(e.target.value),
                  'aria-label': t('title'),
                })
              ),
              h('div', { className: 'ssv-helpWrap' },
                h('button', {
                  type: 'button', className: 'ssv-helpToggle',
                  'aria-expanded': helpOpen ? 'true' : 'false',
                  onClick: toggleHelp,
                }, (helpOpen ? '▾ ' : '▸ ') + t('help.toggle')),
                helpOpen
                  ? h('ul', { className: 'ssv-help' },
                      h('li', null, t('help.whole')),
                      h('li', null, t('help.prefix')),
                      h('li', null, t('help.tokens')),
                      h('li', null, t('help.cjk')),
                      h('li', null, t('help.scope'))
                    )
                  : null
              ),
              query.trim() !== ''
                ? h('div', { className: 'ssv-prefs' },
                    h('label', null,
                      t('hits.perSession'),
                      h('select', {
                        value: String(perSession),
                        onChange: (e) => changePerSession(e.target.value),
                        'aria-label': t('hits.perSession'),
                      }, [1, 2, 3, 5, 8, 12].map((n) => h('option', { key: n, value: String(n) }, String(n))))
                    ),
                    h('label', null,
                      h('input', {
                        type: 'checkbox',
                        checked: includeTools,
                        onChange: (e) => changeTools(e.target.checked),
                      }),
                      t('hits.tools')
                    ),
                    h('label', { title: t('hits.subagentHint') },
                      h('input', {
                        type: 'checkbox',
                        checked: includeSubagent,
                        onChange: (e) => changeSubagent(e.target.checked),
                      }),
                      t('hits.subagent')
                    ),
                    h('label', { title: t('hits.archivedHint') },
                      h('input', {
                        type: 'checkbox',
                        checked: includeArchived,
                        onChange: (e) => changeArchived(e.target.checked),
                      }),
                      t('hits.archived')
                    )
                  )
                : null,
              prefixNote ? h('p', { className: 'ssv-note' }, t('prefixNote')) : null,
              status ? h('p', { className: 'ssv-status' + (error ? ' ssv-error' : '') }, status) : null,
              listContent,
              hasMore ? h('p', { className: 'ssv-more' }, t('more')) : null
            )
          )
        )
      );
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'layout', 'uiWorkspace'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);

        const getList = () => ctx.sessions.list.getSnapshot();
        const currentSessionId = () => {
          const list = getList();
          const rows = (list && list.byId) || {};
          if (lastActiveSessionId && rows[lastActiveSessionId] && !rows[lastActiveSessionId].blank) return lastActiveSessionId;
          const found = Object.values(rows).find((s) => s && ((s.retainedBy && s.retainedBy.mainView) || 0) > 0);
          return found ? (found.id || found.sessionId) : undefined;
        };
        const summaryOf = (id) => {
          const list = getList();
          const s = (list && list.byId && list.byId[id]) || null;
          return s;
        };
        const sessionTitle = (id) => {
          const s = summaryOf(id);
          if (s) {
            if (s.displayTitle) return s.displayTitle;
            if (s.title) return s.title;
            if (s.cwd) return String(s.cwd).split(/[\\/]/).pop() || id;
          }
          return id;
        };
        const sessionTime = (id) => {
          const s = summaryOf(id);
          return s ? (s.updatedAt || 0) : 0;
        };

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ':locale');

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({
            search: (query, signal) => ctx.sessions.search(query, signal),
            listSnapshot: getList,
            currentSessionId,
            sessionTitle,
            sessionTime,
            openSession: (id) => ctx.uiWorkspace.openSession(id),
            close: () => ctx.layout.selectPanel(null),
            // 点逐条命中：打开会话 → 用该命中的原词唤起查找条 → 查找条挑最吻合的一处滚过去。
            revealHit: (sessionId, hit, query) => {
              const needle = matchedNeedle(hit && hit.snippet) || query || '';
              findSeededQuery = needle;
              pendingReveal = { hint: plainSnippet(hit && hit.snippet), attempts: 0 };
              ctx.uiWorkspace.openSession(sessionId);
              // 等目标会话真正换上来再唤起，否则会在上一场的 DOM 上算命中。
              setTimeout(() => { findOpen = true; notifyFind(); }, 240);
            },
            t,
          }),
        }, SearchPanel)), NS + ':main');

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 12,
          label: () => t('panel'),
        }, SearchIcon)), NS + ':entry');

        // 会话页顶部（标题右侧的 utilities 区）加一个搜索入口，随时能进搜索页。
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: PANEL_ID + ':header',
          order: -12,
          locale: NS,
          inject: () => ({ t }),
        }, SearchHeaderButton)), NS + ':header');

        // 更早的历史不在 DOM 里：用会话 service 的 loadThrough(seq) 把窗口翻到那条事件再定位。
        const loadThroughSeq = (seq) => {
          const sid = currentSessionId();
          if (!sid || !seq) return Promise.resolve();
          try {
            return Promise.resolve(ctx.sessions.using(sid, { source: 'workspaceOperation' }, (ref) => (
              ref && ref.binding && ref.binding.session ? ref.binding.session.loadThrough(seq) : undefined
            ))).catch(() => {});
          } catch (_) { return Promise.resolve(); }
        };

        // 会话内查找条：frame 级浮层，不占布局、不跳转页面。
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: PANEL_ID + ':find',
          order: 50,
          locale: NS,
          inject: () => ({ t, loadThrough: loadThroughSeq, findSessionId: currentSessionId }),
        }, FindBar)), NS + ':find');

        // 页面上选中的文字直接当关键词（和浏览器 ⌘F 一致），只在没打开时预填。
        const selectedText = () => {
          try {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return '';
            const text = String(sel.toString() || '').replace(/\s+/gu, ' ').trim();
            return text.length > 0 && text.length <= 120 ? text : '';
          } catch (_) { return ''; }
        };
        // ⌘F / Ctrl+F 接管：Electron 没有浏览器自带的页内查找，这里直接唤起会话内查找条。
        // ⌘⇧F / Ctrl+Shift+F 打开全局搜索面板（和编辑器里"在工作区中查找"同一个手势）。
        const onFindShortcut = (event) => {
          if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
          if (event.key !== 'f' && event.key !== 'F') return;
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          const active = currentSessionId();
          if (active) lastActiveSessionId = active;
          if (event.shiftKey) {
            findOpen = false;
            notifyFind();
            ctx.layout.selectPanel(PANEL_ID);
            return;
          }
          if (!findOpen) {
            const picked = selectedText();
            if (picked) findSeededQuery = picked;
          }
          findOpen = true;
          notifyFind();
        };
        const onFindEscape = (event) => {
          if (!findOpen || event.key !== 'Escape') return;
          const target = event.target;
          const inside = target && target.closest && target.closest('.ssv-find, .ssv-findLayer');
          if (!inside && target !== document.body) return; // 别抢对话框/菜单的 Esc
          findOpen = false;
          notifyFind();
        };
        ctx.effect(() => {
          document.addEventListener('keydown', onFindShortcut, true);
          document.addEventListener('keydown', onFindEscape, true);
          return () => {
            document.removeEventListener('keydown', onFindShortcut, true);
            document.removeEventListener('keydown', onFindEscape, true);
          };
        }, NS + ':shortcut');

        ctx.effect(() => () => {
          try {
            const info = ctx.layout.panelInfo && ctx.layout.panelInfo.getSnapshot && ctx.layout.panelInfo.getSnapshot();
            if (info && info.activePanelId === PANEL_ID) ctx.layout.selectPanel(null);
          } catch (_) { /* layout already gone during teardown */ }
        }, NS + ':dispose');
      },
    };
  },
});
