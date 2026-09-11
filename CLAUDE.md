# cc-synapse

把 Claude Code 的历史会话摊成一张可拖拽缩放的地图。**只读 `~/.claude`，从不写回会话文件**——这是产品承诺，任何改动都不能破坏它。

本仓库 fork 自 `liangmianya/dsh-synapse`（DeepSeek Harness 的 cordis 插件），宿主层已完全替换，但 `src/store.js` 里仍留着上游的 DSH 代码，见「已知的债」。

## 命令

```powershell
corepack pnpm install
node bin/cc-synapse.js --all --dev   # 本地开发，--dev 让前端文件每次请求都重读
corepack pnpm test                   # node --test，无第三方框架
corepack pnpm build                  # 只做语法检查，不产出文件
```

`node bin/cc-synapse.js` 是相对路径，只在仓库目录下有效。要在别的项目里试，先 `npm link`。
拿夹具当数据源：`node bin/cc-synapse.js --claude-dir test/fixtures/claude --all`。

## 结构

零依赖、零构建。`app.js` 由浏览器直接加载，**不能用 import/export**；`src/` 下是原生 ES module，拆分不引入任何构建步骤。

| 文件 | 职责 |
| --- | --- |
| `src/jsonl.js` | 增量读会话文件，只返回新增的行 |
| `src/adapters/claude.js` | 一个会话文件 → 节点序列 |
| `src/lineage.js` | 同工作区内推断父子关系 |
| `src/scanner.js` | 串起上面三者 |
| `src/store.js` | 画布布局持久化（沿用上游的锁与原子写） |
| `src/server.js` | HTTP 路由与三层防护 |
| `src/watcher.js` / `src/spawn.js` | 监听会话目录 / 在新终端打开 Claude |
| `app.js` `styles.css` | 画布本体 |

设计缘由写在 [docs/architecture.md](docs/architecture.md)，里面记了为什么这么选，值得先读。

---

## 改之前必须知道的

下面每一条都是实测踩出来的，代码上看不出问题，错了也不会报错。

### 节点粒度：一个节点 = 一次用户输入 + 完整回合

助手输出只决定节点**内容**，不决定节点**数量**。开启节点的条件只有三种：非噪音的 user 记录、一次 `AskUserQuestion` 的回答、一个 compact 边界。

实测数据说明为什么不能按助手记录分节点：一个回合里带文本的助手记录**只有 31.5% 是一条，44% 有两条以上（最多 76 条）**，另有 **24.7% 一条都没有**（纯工具执行）。逐条建节点会让单个回合炸出几十张卡片；跳过无文本的回合则会让用户的提问从地图上消失。

### `sourceSeq` 必须是整数

画布里有 **13 处** `Number.isInteger` 把关（分支按钮、`seedLength` 比较、卡片 id），非整数会让这些判断**静默失效**而不是报错。节点的 seq 用开启它那一行的行号，助手消息用该回合最后一条 assistant 记录的行号——都是真实行号。

### 分支推断不能用 `createdAt`

续写会话时 Claude Code 会把父会话的历史**整个复制**进新文件，首条记录的时间戳是继承来的。实测同一次分叉出来的两个文件时间戳完全相同，第三个只差 146ms，但实际活动跨度是几小时。

判断谁先存在必须用 `updatedAt`。这个先后判断同时提供了**不对称性**——否则两个会话会互指对方为父，形成 2-环，而 `layoutConversationGraph` 和级联删除都假设是无环森林。

### 增量读取只能回答"变没变"

`JsonlReader` 返回的是上次之后**新增的行**。确认文件变过之后必须**整份重新解析**——会话是一条累积的对话，只投影新增几行会把前面的内容全丢掉。省时间靠的是没变的文件根本不往下走（重复扫描约 6ms）。

半行要以**字节**形式暂存。会话里中文很多，多字节字符被读取边界劈开时，按字符串暂存会在两侧各留一个替换字符，字符永久损坏——既污染正文，也让同一条消息两次读出不同的签名哈希。

### 工作区的键是 `cwd`，不是目录名

Claude Code 存会话用的目录名是路径的**有损转写**，本机上 `C:\神经网络笔记` 和 `C:\价格计算插件` 就撞成了同一个 `c--------`。目录名只能用来缩小搜索范围，归属以记录里的 `cwd` 为准（并统一盘符大小写）。`cwd` 在单个文件里会变，取第一条带 `cwd` 的记录。

扫描只取顶层 `*.jsonl`：`<sessionId>/subagents/agent-*.jsonl` 是 Task 派生的子代理，不是独立会话。

---

## 动 app.js 时的陷阱

### `render()` 会冲掉手动加的类和属性

它用 `innerHTML` 重建整棵树。概览模式的类、tooltip 的暂存属性都因此丢过。任何在 render 之外加到 DOM 上的东西，都要在 render 之后重新同步一次。

### 「正在看某张卡片」有三种形态

加交互时三条都要覆盖，我分三次才补齐：

| 形态 | 判据 | 注意 |
| --- | --- | --- |
| 卡片侧边面板 | `state.inspectorCardId !== null` | **`state.mode` 仍是 `'canvas'`** |
| 全屏详情 | `state.mode === 'thread'` | 从卡片「详情」按钮进来才有 `detailOriginCardId` |
| 侧边栏/详情 tab 进入 | `state.mode === 'thread'` | **没有** `detailOriginCardId` |

### 测试靠函数名切片加载 app.js

`node:vm` 按函数名切出片段来跑，**重命名这些函数会让测试静默失效**：

```
function overlapsCard        function canvasConnectors
function markdownBlock       function conversationCard(card, graph)
```

`canvas-runtime.test.js` 里还有一批**对源码文本做正则断言**的用例。它们守的是修过的真实缺陷（相机不重置、滚动位置保持、概览模式的常量），改对应代码时要同步更新。这是明知的脆弱，范围已压到最小。

`canvas-contract.test.js` 守的是 adapter 产物与画布之间的接缝——改 adapter 时最先看它。

---

## 不能碰的

- **只读红线**：除了画布布局（默认 `~/.cc-synapse/workspaces.json`），不写任何文件。归档只是把会话加进 `hiddenSessionIds`，磁盘上的会话文件原样保留。
- **三层访问防护**（`src/server.js`）：只监听回环地址、校验 `Host`、非 GET 请求要求同源。第三层守的是唤起会话那个接口——别的网页不能借浏览器启动进程。
- **唤起会话的工作目录只从已扫描的会话里取**，绝不接受请求体传入。接受调用方给的路径，这个接口就成了任意目录执行。参数一律以数组传给终端，中间不经过 shell。

## 已知的债

- `src/store.js` 里有大量 DSH 遗留（`syncSessions` / `projectSession` / `dshWorkspace` 等，约 40 处引用），P0 已无调用者。**刻意没删**：它们仍被 30+ 个测试覆盖，而那些测试同时守着持久化、文件锁、原子写这些仍在用的机制。留到 P1 接 Codex 时连同 adapter 抽象一起重构。
- `app.js` 里有草稿残留（`state.draft`、`quickPhrases`、`openNewSession` 等，约 50 处引用），P0 不发消息所以走不到。
- 分支手动修正的入口没做：`rememberBranchAnchor()`（[app.js:85](app.js#L85)）已能持久化但**没有调用者**。

剩余工作见 [TODO.md](TODO.md)。

## 约定

- 提交信息用 conventional commits，正文说清**为什么**这么改、放弃了什么——这个仓库里绝大多数改动的理由都不显然。
- 注释写取舍和缘由，不复述代码在做什么。
- 改完跑 `pnpm test`；碰到画布交互的改动，用浏览器真跑一遍再说"好了"——这一轮里好几个"修好了"都是没真跑而误判的。
