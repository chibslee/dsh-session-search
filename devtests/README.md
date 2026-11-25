# devtests

出厂自带的四个回归测试，不需要启动 App，`node devtests/t_xxx` 直接跑：

| 文件 | 覆盖什么 | 依赖 |
| --- | --- | --- |
| `t_find2.cjs` | 插槽注册、计数显示（`…` / `n/m` / 悬停标题）、空结果时按钮禁用 | 无（stub React + stub DOM） |
| `t_landing.mjs` | `waitForLanding` 的轮询/超时/令牌失效语义 | 无（假 document） |
| `t_scroll.mjs` | `scrollElementIntoView` 只滚会话容器、不动窗口；远距离瞬时、近距离平滑、已居中不抖；宿主标记自身不可滚时找内层滚动元素 | `playwright-core` + 本机 Chrome |
| `t_jump.mjs` | `jumpWhole` 的真实行为：目标不在 DOM 时先探测再 `loadThrough`、已在 DOM 时不翻页、连按两次只保留最后一次且 busy 复位、翻页抛错也能复位 | `playwright-core` + 本机 Chrome |

`playwright-core` 解析顺序：`$PLAYWRIGHT_CORE` → `playwright-core` → `playwright` → desktop profile 里的副本（本机路径见文件内）。没有装就先 `npm i -D playwright-core`。

改 `client.js` 的滚动/定位逻辑后至少跑 `t_jump.mjs` 和 `t_scroll.mjs` —— 这两个是 0.1.2 那次"改了但真机上按上下箭头完全不动"的唯一防线（0.1.3 的根因是翻页水位线初始化成 `Infinity`，stub 测试看不出来）。
