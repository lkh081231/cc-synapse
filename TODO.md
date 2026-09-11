# cc-synapse P0 收尾清单

截至 `1aef688`：64 个提交、126 个测试全绿、功能可用（`cc-synapse` 已 `npm link`，任意目录可跑）。

计划里的七个阶段都已落地：JSONL 解析、分支推断、本地服务、画布改造、文件监听、唤起终端、文档重写。下面是**还没做完的部分**。

---

## 必须做（否则不算交付）

### 1. 推送并让 CI 真正跑一次
本地领先远程 **20 个提交**，CI 一次都没跑过。
`.github/workflows/` 刚加了 `windows-latest` 这条腿，**从未验证过**——路径归一化、spawn 的探测链、fixture 行尾都是平台相关的，很可能第一次跑就红。

```powershell
git push
gh run watch      # 或看 Actions 页面
```

### 2. 真机点一次「在 Claude 中打开」
spawn 只验证过**命令拼装**（`conhost.exe` + 数组传参，本机没有 `wt.exe`），**从没真的弹过终端窗口**。
要确认：窗口起得来、`--resume` 进对了会话、工作目录正确、含空格/中文的路径不出错。

### 3. 决定要不要发 npm
`cc-synapse` 这个名字仍然可用（registry 404），版本 `0.1.0`。
发之前需要：`gh secret set NPM_TOKEN --repo lkh081231/cc-synapse`，然后打 `v0.1.0` 的 tag 触发 `npm-publish.yml`。
不发也行——`npm link` 自用完全够。但 README 里写的是 `npx cc-synapse`，不发的话那句话是空头支票。

---

## 计划里承诺过但没做

### 4. 手动修正分支关系的入口
分支是靠**共享提问前缀**推断的，一定会有猜错的时候。
`rememberBranchAnchor()`（[app.js:85](app.js#L85)）已经写好并能持久化到 localStorage，**但没有任何调用者**——覆盖机制有存储、没入口。
需要一个 UI：拖连线到别的卡片，或右键菜单选「改到这张之后」。
`confidence` 字段服务端已经在算了，低置信度的连线也可以先画成虚线提示不确定。

---

## 想清理的债

### 5. `src/store.js` 里的 DSH 死代码（~20 处引用）
`syncSessions` / `projectSession` / `projectEvent` / `dshWorkspace` / `dshThread` 等在 P0 已无调用者。
**当初刻意没删**：它们仍被 30+ 个测试覆盖，而那些测试同时守着**持久化、文件锁、原子写**这些仍在用的机制。删代码就要连带删测试，风险大于收益。
建议留到 P1 接 Codex 时，连同 adapter 抽象一起重构。

### 6. `app.js` 里的草稿残留（~45 处）
`state.draft`、`draftCard`、`quickPhrases`、`openNewSession`（已无调用者）等。
P0 不发消息，这些 UI 路径走不到，但散落在渲染逻辑里，删起来要小心不碰坏画布。

---

## 已知限制（不一定要改，但该记着）

- **subagent 不成图**：`Task` 派生的会话在 `<sessionId>/subagents/*.jsonl`，目前只作为工具调用出现在所属卡片里。做成子节点要给数据模型加一层嵌套。
- **CC 的 JSONL 没有格式承诺**：样本全是 2.1.x。adapter 已做宽容解析（未知 type 忽略、字段缺失降级），但 Anthropic 改字段仍可能悄悄失效。
- **`canvas-runtime.test.js` 是源码文本断言**：改对应代码时要同步改测试。已知脆弱，范围压到了最小（守的都是修过的真实缺陷）。

---

## 交接要点

三条非显然的结论已存进 `~/.claude/projects/c--cc-synapse/memory/`：

- **节点粒度**：一个节点 = 一次用户输入 + 完整回合。实测只有 31.5% 的回合是单条助手文本，44% 有两条以上（最多 76 条），另有 24.7% 一条都没有。按助手输出分节点会让画布崩掉。
- **`createdAt` 不可用**：续写会复制父会话历史，首条时间戳是继承来的。分支推断必须用 `updatedAt`。
- **增量读取只能判断"变没变"**：变了就要整份重解析，直接拿增量结果拼装会丢掉全部历史。

另外三个反复踩到的坑（不在 memory 里，但值得知道）：

- `sourceSeq` **必须是整数**：画布多处用 `Number.isInteger` 把关，小数会让分支按钮静默失效。
- 「正在看某张卡片」有**三种形态**：卡片侧边面板（mode 仍是 canvas）、全屏详情、侧边栏进详情。加交互时三条都要覆盖，我分三次才补齐。
- `render()` 用 `innerHTML` 重建 DOM，会冲掉手动加的类和属性（概览模式、tooltip 状态都栽过）。
