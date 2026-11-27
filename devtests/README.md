# devtests

出厂自带的四个回归测试，不需要启动 App，`node devtests/t_xxx` 直接跑：

| 文件 | 覆盖什么 | 依赖 |
| --- | --- | --- |
| `t_find2.cjs` | 插槽注册、计数显示（`…` / `n/m` / 悬停标题）、空结果时按钮禁用 | 无（stub React + stub DOM） |
| `t_landing.mjs` | `waitForLanding` 的轮询/超时/令牌失效语义 | 无（假 document） |
| `t_scroll.mjs` | `scrollElementIntoView` 只滚会话容器、不动窗口；远距离瞬时、近距离平滑、已居中不抖；宿主标记自身不可滚时找内层滚动元素 | `playwright-core` + 本机 Chrome |
| `t_jump.mjs` | `jumpWhole` 的真实行为：目标不在 DOM 时先探测再 `loadThrough`、已在 DOM 时不翻页、连按两次只保留最后一次且 busy 复位、翻页抛错也能复位；**落位期间连按被排队而不是丢弃**、排队步数真被执行、索引未就绪时按键先排队 | `playwright-core` + 本机 Chrome |

`playwright-core` 解析顺序：`$PLAYWRIGHT_CORE` → `playwright-core` → `playwright` → desktop profile 里的副本（本机路径见文件内）。没有装就先 `npm i -D playwright-core`。

改 `client.js` 的滚动/定位逻辑后至少跑 `t_jump.mjs` 和 `t_scroll.mjs` —— 这两个是 0.1.2 那次"改了但真机上按上下箭头完全不动"的唯一防线（0.1.3 的根因是翻页水位线初始化成 `Infinity`，stub 测试看不出来）。

## 0.1.4：Enter 和「下一个」按钮行为不一致

症状：点按钮能跳，按 Enter 没反应或跳错位置。根因四条，都在时序上，不在 `step` 本身：

1. `e.repeat` 没过滤：按住 Enter 时 keydown 连发，每次 `jumpToken += 1` 都把上一次作废，最终一次都不落位。
2. 索引 220ms 去抖 + 一次 HTTP：敲完词立刻按 Enter 时 `wholeHitsRef` 还是上一个关键词的列表（或空），`step` 拿着旧 `seq` 去跳 → 跳到无关位置，或退回只看已渲染 DOM 的分支 → 不动。
3. IME 组字时 Enter 提交候选被当成"下一个"。
4. 按键冒泡到 App 自己的 keydown；按钮点击抢走输入框焦点。

修法：`pendingStepsRef` 队列（busy 或索引未就绪时排队，落位后 `shift` 补跳，上限 20）、`indexForRef` 记住"这个关键词的索引算过了"、换词时清空旧的命中列表、`e.isComposing || e.keyCode === 229` 早退、`stopPropagation()`、按钮 `onMouseDown: preventDefault`。
