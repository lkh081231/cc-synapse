# cc-synapse — English guide

Lays your Claude Code history out as a map. It only reads `~/.claude` and never writes back to a session file.

## Install and run

Requires Node.js `>= 22.19.0`. From any project directory:

```powershell
npx cc-synapse
```

A browser opens on the sessions for that directory. Add `--all` to see every project at once.

Or install it globally:

```powershell
npm install -g cc-synapse
cc-synapse
```

Before the package is published, run `npm link` once in the repository and
`cc-synapse` works from any directory. `node bin/cc-synapse.js` is a relative
path and only runs from the repository itself.

## The interface

**The sidebar** lists the sessions in the current workspace. Ones marked 分支 continue from another session. The dropdown above switches workspaces.

**The canvas** gives each question and its answer one card. The number in the corner counts the tool calls in that turn; 详情 opens the full record, including reasoning and every tool call's arguments and result.

**Connectors** show lineage: a session continued from another one attaches beside the question it branched at.

## What you can do

| Action | Result |
| --- | --- |
| Drag a card | Moves it; the position is remembered |
| Wheel | Zooms the canvas (20%–400%), or scrolls an answer when over a card |
| Collapse | The minus on a card hides everything after it |
| 整理 | Re-lays out every card |
| 定位 | Returns to the current session (picking one in the sidebar already centres it) |
| 详情 | Opens the full transcript |
| Claude | Opens a terminal window and `--resume`s that session |
| 归档 | Hides a session from the map; the file on disk is untouched |
| 重新扫描 | Re-reads `~/.claude` immediately |

You rarely need to rescan by hand — a message you send in the terminal shows up within a second or two.

## Options

```
--port <n>          Port to listen on (chosen automatically by default)
--host <h>          Address to bind (default 127.0.0.1)
--cwd <path>        Project directory to show (default: current directory)
--all               Show every project
--claude-dir <p>    Claude Code's data directory (default ~/.claude)
--data-file <p>     Where to keep the canvas layout
--claude-bin <p>    Path to the claude executable
--no-open           Do not open a browser
--no-spawn          Disable opening sessions in Claude
--dev               Re-read front-end files on every request
```

## Data and safety

The only file the canvas writes is its own layout, by default `~/.cc-synapse/workspaces.json`, holding card positions and the archived list. Deleting it loses the layout and nothing else; session content is read again on the next start.

The server binds `127.0.0.1`, checks the `Host` header, and requires writes to be same-origin. The working directory for "open in Claude" comes only from an already-scanned session, never from the request. Use `--no-spawn` to turn that route off entirely.

## Known limits

- **Lineage is inferred.** Session files record no fork, so parentage is recovered from the shared prefix of questions and can occasionally attach at the wrong point.
- **Subagents are not mapped.** Sessions spawned by `Task` live in separate files and currently appear only as tool calls on the card that started them.
- **The canvas is read-only.** Continue a conversation in the terminal.

## Uninstall

```powershell
npm uninstall -g cc-synapse
```

Remove `~/.cc-synapse/` by hand if you want the layout gone too.
