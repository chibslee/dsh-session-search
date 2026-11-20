# dsh-keyword-searcher

给 DeepSeek Harness（DSH）用的**会话全文搜索**插件：左侧栏一个搜索面板 + 会话页内一个 `⌘F` 查找条，全部本地匹配，不调模型、不花 token。

- 跨所有 workspace / 会话检索历史消息，点结果打开会话并跳到命中处。
- 每场会话可以展开逐条命中（第几处、用户还是 AI 说的、时间、片段）。
- 会话页 `⌘F` 就地查找，覆盖**整段对话**（历史没加载进 DOM 也能翻回来定位）。
- 「含子会话 / 含归档」默认关闭，需要时勾上。
- 整词没命中时自动退回前缀匹配（`symbo` → `symbol`）。

## 前置条件

1. DSH `0.2.2-rc.5` 左右（插件用到的 `ctx.sessions.search`、`sessionQuery` 索引、`shell.overlay` 插槽）。
2. **全局 session-query 索引必须是打开的**。DSH 默认把 `session-query-sqlite` 的 `openAt` 配成 `never`（只有标题搜索），需要在 profile 的 `cordis.patch.yml` 里覆盖：

   ```yaml
   - id: session-query-sqlite
     config:
       path: /Users/<you>/.dsh/session-query.sqlite
       openAt: first-search
   ```

   注意 patch 会替换整段 `config`，`path` 必须一起写。改完重启一次 DSH，索引会在第一次搜索时建好（本机 140k 文档约 300MB，重建几分钟）。

## 安装

```bash
dsh plugin --profile <profile> add dsh-keyword-searcher
```

或直接从仓库装（等价，跳过 npm）：

```bash
dsh plugin --profile <profile> add github:chibslee/dsh-session-search
```

本地开发用链接方式：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-session-search
```

> **装不上时**：如果报 `ERR_PNPM_TARBALL_EXTRACT … dsh-keyword-searcher-0.0.0-stage.tgz`，是淘宝镜像（`registry.npmmirror.com`）缓存了首次发布时的 `0.0.0-stage` 占位文档。换源装：
>
> ```bash
> dsh plugin --profile <profile> add dsh-keyword-searcher --registry=https://registry.npmjs.org
> ```
>
> 或等镜像同步完再试。

装完重启一次 DSH（host 侧路由要跟着起），之后左侧栏出现「会话全文搜索」入口。

## 用法

| 操作 | 位置 |
| --- | --- |
| 打开搜索面板 | 侧栏「会话全文搜索」，或任意页面按 `⌘⇧F` / `Ctrl+Shift+F` |
| 返回 | `Esc`，或左上角「返回对话」 |
| 会话内查找 | 会话页按 `⌘F` / `Ctrl+F`，或标题右侧放大镜 |
| 上/下一条 | 查找条里 `Enter` / `Shift+Enter`，或 ↑ ↓ |

搜索语法（FTS5，`unicode61` 分词）：

- **整词匹配**：`symbol` 命中 symbol 及包含它的词；`symbo` 先整词试，无结果自动按前缀（→ symbol、symbolic）。
- **前缀只从词首算**：`mbol` 搜不到 `symbol`。
- **空格分词、AND 组合**：`缓存 清理` 要求两个词都出现。
- **中文按连续字串**，英文不区分大小写；标点、引号按普通字符处理。

## 实现

- `client.js`：手写的 module-loader 产物（`window.__ModuleLoader__.load({...})`），注册四个插槽 —— `main`（面板）、`sidebar.panellist`（入口）、`conversation.session.header.utilities`（放大镜）、`shell.overlay`（查找条与高亮层）。
- `index.js`：host 侧，注册两条同源只读路由：
  - `GET /ssv-search/events?q=&ids=&perSession=&tools=` —— 直接读 `~/.dsh/session-query.sqlite` 的 FTS5 表（`persisted_docs`），一条 `MATCH` 几毫秒；官方 `searchEvents` 每次调用都全量重观测索引，逐会话调用会慢到秒级。
  - `GET /ssv-search/state` —— 返回 subagent / 归档会话名单，供面板过滤。
- 高亮用 overlay 色块（`Range.getClientRects()` + 绝对定位），不用 CSS Custom Highlight API —— 后者在 Electron 里会静默失效。

## 已知限制

- 依赖 `session-query-sqlite` 的索引 schema（`persisted_docs` 虚表），DSH 升级后可能需要跟着改。
- 思维链（reasoning）不在索引里，只能搜正文与工具输出。
- 路由不校验鉴权，只监听 loopback 同源；如果你把 DSH 暴露到公网，请自行加一层。
- 单场会话命中超过 200 条时，计数是真的，但只能跳前 200 条。

## License

MIT
