// cc-synapse —— Claude Code 会话地图
//
// 本文件是薄壳：实现在 src/ 下。保留它是为了让 package.json 的 `main`
// 有一个稳定入口，并让既有测试的 `from '../index.js'` 继续可用。
//
// 服务端入口是 src/server.js（由 bin/cc-synapse.js 启动）。

export { WorkspaceStore } from './src/store.js'
