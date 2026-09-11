# cc-synapse P0 收尾清单

截至 `7d2d9c3`：67 个提交、126 个测试全绿、功能可用（`cc-synapse` 已 `npm link`，任意目录可跑）。已推送到 `origin/main`。

计划里的七个阶段都已落地：JSONL 解析、分支推断、本地服务、画布改造、文件监听、唤起终端、文档重写。下面是**还没做完的部分**。

---

## 必须做（否则不算交付）

### 1. 让 CI 真正跑一次 —— 卡在仓库设置，**待用户处理**
已推送，远程 `main` 到 `0f37bf2`。但 **Actions 一个 run 都没生成**：
三个 workflow 都是 `state: active`，仓库是 public，`push: branches: [main]` 条件也满足，
推完十分钟仍然 `total_count: 0`。这个组合只剩一种解释——**仓库级别把 Actions 关掉了**。

要用户去 Settings → Actions → General 打开 "Allow all actions"，
然后随便推一个提交（或在 Actions 页面点 Run workflow）触发一次。

`windows-latest` 这条腿仍然**从未验证过**——路径归一化、spawn 的探测链、
fixture 行尾都是平台相关的，第一次跑很可能红。本地 Windows 上 126 个测试是绿的，
但那是 Git Bash，不等于 CI 的 `windows-latest`。

顺带：本机 `gh` 的 token 已失效（keyring invalid），要 `gh auth login` 重新登录，
否则 `gh run watch` / `gh secret set` 都用不了。

### 2. ~~真机点一次「在 Claude 中打开」~~ —— 已验证 ✅
本机真的 spawn 了一次，四件事都对上了：

- **窗口起得来**：`conhost.exe` (PID 8396) + `claude.exe` (PID 17164) 同一秒起，窗口标题 `claude`
- **`--resume` 进对会话**：命令行就是 `claude.exe --resume 489e1b8b-…`，父进程是那个 conhost
- **工作目录正确**：只有 `c--cc-synapse` 这个 project 目录被写到，即 cwd 落在 `C:\cc-synapse`
- **空格/中文路径**：`C:\path with space\proj` 和 `C:\中文目录\项目` 参数都原样传到数组里，没有被重新解析

本机没有 `wt.exe`，走的是 `conhost.exe` 这条兜底分支；`wt.exe` 和 `cmd.exe /c start` 两条仍未真机验证。

### 3. 发 npm —— 卡在凭据，**待用户处理**
包名定为 **`cc-synapse`**，registry 仍然 404（名字没被占），`package.json` 里版本 `0.1.0`，字段齐全。

发不了的原因是本机两个凭据都没有：`npm whoami` 是 `ENEEDAUTH`，`gh` 的 token 也失效了。
发布本身是对外动作，也不该我替你按。要发的话：

```powershell
gh auth login                                            # 先修好 gh
npm login                                                # 或直接去 npmjs.com 生成 token
gh secret set NPM_TOKEN --repo lkh081231/cc-synapse
git tag v0.1.0 && git push origin v0.1.0                 # 触发 npm-publish.yml
```

注意 `npm-publish.yml` 跑在 ubuntu 上，会先跑一遍 `pnpm test`——**Actions 没打开的话这条也不会触发**，
所以顺序上得先解决第 1 条。

不发也行——`npm link` 自用完全够。但 README 里写的是 `npx cc-synapse`，不发的话那句话是空头支票。

---

## 计划里承诺过但没做

### 4. ~~手动修正分支关系的入口~~ —— 已做 ✅（`0f37bf2` + `7d2d9c3`）
右键任意**分支首卡** → 菜单「改到这张之后」→ 选新的父卡片。已浏览器实测：
改连线、落 localStorage、刷新后仍在、「恢复自动推断」能退回，概览模式下同样可用。

**Ctrl+Z 可撤销**（`7d2d9c3`）。栈里存的是改之前的**原值**而不是"删掉锚点"——
撤销要能退回上一个手工指定的父卡片，而不是一路退到自动推断。实测三级连撤
`237 → 62 → 50 → 推断值` 逐步退回，栈空时提示「没有可撤销的分支改动」，
焦点在搜索框时不接管（留给浏览器自带的文本撤销）。

撤销只管分支锚点，不管拖动卡片：拖错了把它拖回去就行，混进同一个栈反而猜不到
Ctrl+Z 会撤哪一个。提示走新加的 `.canvas-toast`，没有复用 `.status-message`——
那个是红底 `role="alert"`，撤销成功却显示成报错。

**选了右键菜单，没做拖连线**：卡片已经绑了 `pointerdown` 拖动、画布还要靠 `pointerdown` 平移，
再插一条拖拽手势要跟这两个抢事件；而且概览模式下卡片缩成小方块，边缘没地方放拖拽把手——
恰恰是最需要改连线的时候。

`confidence` 也用上了：低于 `.5` 的推断连线画成**黄色虚线**，手工定过的画成**实线加粗**。

踩到两个真问题，都已修掉：

- **锚点不能用 `thread.id` 或卡片 id 存**。那两个是每次重建投影时 `randomUUID()` 出来的，
  服务重启就变——改完看着生效，重开就悄悄退回推断值，而且不报错。
  现在两端都按 `sessionId + sourceSeq` 存。**这条对以后任何要持久化的画布状态都成立。**
- **搜索框不能走 `render()`**。`render()` 是 `innerHTML` 重建，每敲一个字都会把输入框连同
  焦点和光标一起冲掉。现在就地过滤已渲染的行。

候选排除了自己的后代（接上去成环）。布局和子树计数各自都防了环不会挂，但连线会画成一团乱麻，
不该让用户选得到。

---

## 想清理的债

### 5. `src/store.js` 里的 DSH 死代码（~20 处引用）
`syncSessions` / `projectSession` / `projectEvent` / `dshWorkspace` / `dshThread` 等在 P0 已无调用者。
**当初刻意没删**：它们仍被 30+ 个测试覆盖，而那些测试同时守着**持久化、文件锁、原子写**这些仍在用的机制。删代码就要连带删测试，风险大于收益。
建议留到 P1 接 Codex 时，连同 adapter 抽象一起重构。

### 6. `app.js` 里的草稿残留（~45 处）
`state.draft`、`draftCard`、`quickPhrases`、（已无调用者）等。
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
