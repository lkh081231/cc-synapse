# 开发与发布

## 环境

Node.js `>= 22.19.0`，pnpm 10。项目零依赖、零构建——`app.js` 由浏览器直接加载，服务端是原生 ES module。

```powershell
corepack pnpm install
```

## 本地运行

```powershell
node bin/cc-synapse.js --all --dev
```

`--dev` 让前端文件每次请求都重新读取，改完刷新即可，不用重启。常用的还有 `--port` 固定端口和 `--no-open` 不自动开浏览器。

想用别处的会话数据（比如测试夹具）：

```powershell
node bin/cc-synapse.js --claude-dir test/fixtures/claude --all
```

## 测试

```powershell
corepack pnpm test     # node --test，无第三方框架
corepack pnpm build    # 只做语法检查，不产出文件
```

夹具在 `test/fixtures/claude/`，都是手写的十几行 JSONL，覆盖节点粒度、噪音过滤、上下文压缩、目录名冲突等场景。**不要拿真实的 `~/.claude` 当夹具**——里面有隐私内容，体积也不适合进仓库。

几处测试的写法值得留意：

- `conversation-cards.test.js` 和 `canvas-runtime.test.js` 用 `node:vm` 按函数名切出 `app.js` 的片段来跑。切片锚点是 `function overlapsCard` 和 `function canvasConnectors`，重命名这两个函数会让测试失效。
- `canvas-runtime.test.js` 有几条是对源码文本做正则断言的。它们守的是修过的真实缺陷（相机不重置、滚动位置保持），但改动对应代码时需要同步更新——这是明知的脆弱，范围已压到最小。
- `canvas-contract.test.js` 守的是 adapter 产物与画布之间的接缝，改 adapter 时最先看它。

## 发布

版本号与 tag 必须一致，CI 会校验。

```powershell
corepack pnpm version patch
git push --follow-tags
```

推送 `v*.*.*` 形式的 tag 会触发 `npm-publish.yml`：校验 tag 与 `package.json` 版本一致 → 安装 → 语法检查 → 测试 → 发布。带 `-` 的版本走 `next` 通道，其余走 `latest`。已发布过的版本会跳过而不是报错。

首次发布前需要配置令牌：

```powershell
gh secret set NPM_TOKEN --repo lkh081231/cc-synapse
```
