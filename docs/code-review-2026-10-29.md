# Reins 代码库全面审查报告

- **审查日期**：2026-10-29
- **代码规模**：`src/` 207 个 TypeScript 文件，34,524 行；`tests/` 151 个文件
- **审查方式**：逐文件通读 + 静态推演 + 关键路径实机复现
- **基线状态**：`npm run typecheck` 通过；`npm test` 正常时 1366 通过 / 0 失败 / 3 跳过
  - ⚠️ **存在可复现的偶发失败**：5 轮里 2 轮失败，均为 `tests/tools/jobs.test.ts:68`「kill 结束进程并落成 killed」，且失败后**整个测试进程挂住不退出**（第 3 轮运行 13 分钟无进展，需手工终止）。根因是两个产品缺陷叠加，见 P2-22 与 P2-23

---

## 一、优先级汇总

| 等级 | 数量 | 含义 |
| --- | --- | --- |
| P0 | 1 | 会损坏用户数据或阻断启动，必须立即修 |
| P1 | 6 | 安全边界缺陷或确定性功能错误 |
| P2 | 23 | 资源泄漏、性能瓶颈、错误处理缺口 |
| P3 | 19 | 健壮性与可维护性改进 |

---

## 二、P0 阻断

### P0-1 TOML 内联表回写会写错位置，并永久损坏用户全局配置

- **位置**：`src/config/toml/document.ts:99-130`（`#hasImplicitTable` / `#implicitTableEnd`）、`src/config/write-back.ts:69-84`
- **风险**：数据损坏 + 启动阻断

`#hasImplicitTable()` 只要发现同路径存在赋值，就认定父表是「点分键建立的隐式表」，随后把新键插在该赋值的 `valueEnd` 之后。但**内联表**（`ui = { ... }`、`plugins = {}`）在解析结果里同样是一条赋值，插在它后面得到的是**根级键**，不是表成员。

已实机复现（`TomlDocument.set(["ui","notify"], "bell")`）：

```toml
# 回写前
provider = "p"
model = "m"
ui = { notify = "auto" }
plugins = {}

# 回写后
provider = "p"
model = "m"
ui = { notify = "auto" }
notify = "bell"        ← 写到了根级，ui.notify 仍是 "auto"

plugins = {}
```

- `doc.get(["ui","notify"])` 回读仍是 `"auto"`，**调用方以为写成功了**。
- 下次 `ConfigFile.load()` 直接抛 `Unknown key notify`，reins 在该机器上**完全无法启动**，必须手工删行才能恢复。

触发路径不止 `/model`：`recordTrust()` 会写 `plugins.trusted`，用户配置里只要有 `plugins = {}` 就会踩中。

- **修复建议**：
  1. `#hasImplicitTable` 区分「点分键」与「内联表」：前者可插入，后者要么抛 `ConfigError("rewrite \`ui = { ... }\` as a [ui] section")`，要么整体重写内联表值。
  2. `set()` 结束前断言 `this.get(path)` 确实等于目标值，不一致即抛错。这一条能兜住本节所有写偏的情形，成本极低。
  3. `write-back.ts` 落盘前用 `parseConfig` 校验新文本，失败则放弃写入并保留原文件。

---

## 三、P1 严重

### P1-1 跨数据块粘贴可绕过审批卡与信任页，替使用者做安全决策

- **位置**：`src/tui/input/dispatch.ts:88`、`:116`、`:121`、`:125`；对照 `src/tui/input/keys.ts:99-108`、`src/tui/input/transcript.ts:401`
- **风险**：审批绕过（安全边界）

`stripPasteContent()` 的正则是 `\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)`，只能剥掉**同一个数据块内**的粘贴内容。跨块粘贴本应靠 `state.pasting` 记忆，`dispatch.ts:39-43` 也确实为此写了 `interactiveText(text, pasting)`。

但 `state.pasting` **只在编辑器路径 `transcript.ts:401` 被更新**。四个模态分支——信任页（`:88`）、审批卡（`:116`）、模态菜单（`:121`）、整屏页（`:125`）——既不读也不写它，全部直接调用 `stripPasteContent(text)`。

- **触发**：审批卡或信任页打开时粘贴一段超过 TTY 单块上限（约 64 KB）的内容。第一块含 `\x1b[200~`，被剥成空串；后续块没有起始标记，**原样返回**。
- **后果**：后续块里的 `\r` 被 `approvalKey()` 判成 `enter` → `resolveApproval(state.approvalSelection)`，默认选中项是 `"once"`，即**直接放行**；信任页同理直接 `resolveTrust("trust")`。剪贴板内容替使用者批准了工具调用或授予了工作区信任。

代码注释明确说这是要防的攻击面，防线却只覆盖了单块粘贴。

- **修复建议**：把 `pasting` 状态的推进提到 `createInputHandler` 顶部（每次 `decoder.write` 后按 `\x1b[200~` / `\x1b[201~` 的出现次数更新），四个模态分支统一改用 `interactiveText(text, state.pasting)`。顺带修掉「丢失 `\x1b[201~` 后 `pasting` 永久为真」的隐患。

### P1-2 子代理并发调用共享消息数组，导致会话错乱与请求被拒

- **位置**：`src/agent/subagent.ts:120`（`#messages` 实例字段）、`:134`（`this.#messages = messages`）、`:302`（`#toolRunDeps` 里的 `push`）
- **风险**：确定性功能错误

`createSubagentTool()` 只创建一个 `Subagent` 实例。`runToolCalls()` 用 `Promise.allSettled(calls.map(...))` **并行**执行同一响应里的所有工具调用。模型一次发出两个 `subagent` 调用时：

1. 运行 A 把 `this.#messages` 指向 `messagesA`；
2. 运行 B 把它覆盖成 `messagesB`；
3. A 的工具结果全部被 `push` 进 `messagesB`。

结果是 A 的助手消息带着 `tool_calls` 却没有对应的 `toolResult`，B 则多出 `callId` 不存在的工具结果——两者都会让下一次请求被端点以 400 拒绝。注释只考虑了「一个实例跑两次」（串行），没考虑并发。

- **修复建议**：把 `#messages` 改为 `run()` 的局部变量，通过参数传给 `#toolRunDeps(context, messages)`，彻底去掉实例级可变状态。

### P1-3 已中止的 signal 仍会发起一次完整的模型请求

- **位置**：`src/agent/driver.ts:120-123`
- **风险**：多计费 + 响应被丢弃

```ts
const stop = new AbortController();
const onOuterAbort = (): void => stop.abort();
signal.addEventListener("abort", onOuterAbort, { once: true });
```

`AbortSignal` 在**已中止之后**注册的监听器永远不会被调用（已实机验证）。当 `signal` 在进入 `#runTurn` 之前就已中止（例如使用者在上一次工具执行或上下文压缩期间按了 Ctrl+C），`stop` 永远不会 abort，`client.stream()` 会发出一次**真实的、未被中止的** HTTP 请求。

对照 `compactor.ts:162-163` 的正确写法——`if (signal.aborted) controller.abort(); else signal.addEventListener(...)`——可见这里是遗漏而非设计。

- **修复建议**：注册监听器前先判 `signal.aborted`，已中止则立即 `stop.abort()`；或在 `#runTurn` 入口直接返回 `"end"`。

### P1-4 SIGTERM / SIGHUP 不还原终端，raw mode 与备用屏留给使用者

- **位置**：`src/tui/layout.ts:236`（只注册了 `SIGINT`）、`src/tui/runtime/lifecycle.ts:34-86`
- **风险**：终端不可用（实际使用中最高频的投诉）

`SIGTERM`（`kill`、容器/CI 停止）与 `SIGHUP`（关窗口、SSH 断线）走默认动作直接终止进程，`cleanup()` 不会执行。全仓仅有 `print-mode.ts:36` 与 `layout.ts:236` 两处进程级监听，没有 `uncaughtException` / `exit` 兜底。

进程消失后终端仍处于 raw mode、备用屏、鼠标上报（1002/1003）与 bracketed paste 开启状态——shell 无回显、滚轮输出转义序列，使用者必须手动 `reset`。

- **修复建议**：`layout.ts` 同时把 `SIGTERM` / `SIGHUP` 接到 `cleanUp`；再加一个幂等的 `process.on("exit", restoreTerminal)`，只写 `DISABLE_MOUSE + SHOW_CURSOR + CURSOR_DEFAULT + LEAVE_ALTERNATE_SCREEN`，不碰状态，作为所有异常路径的最后一道兜底。

### P1-5 grep 先把整个文件读进内存，再判断大小

- **位置**：`src/tools/builtin/grep.ts:104-113`

```ts
const buffer = readFileSync(path);
if (buffer.length > MAX_FILE_BYTES) return undefined;
```

大小检查在**读取之后**。工作区里一个 1 GB 的日志文件会让进程一次性分配 1 GB（`MAX_FILE_BYTES` 的 2 MB 上限完全没起作用），轻则卡住事件循环，重则 OOM。`MAX_WALK_ENTRIES = 100_000` 意味着一次 grep 可能连续踩中多个这样的文件。

- **修复建议**：改为 `statSync(path).size` 预判，超限直接跳过；`readFileSync` 仍保留 try/catch 兜住 TOCTOU。

### P1-6 信任页承诺「只读」，但项目配置可以启动任意本地进程

- **位置**：`src/tui/page/trust.ts:24-25`（`TRUST_NOTE`）、`src/config/merge.ts:54`（`shellPath`）、`:115-124`（`mcpServers`）、`src/mcp/service.ts:228-236`（`spawn`）
- **风险**：安全承诺与实现不一致

信任页文案写的是：

> `Trusting lets those files take effect. Reins only reads them; commands still run under the sandbox and the approval rules.`

事实是：被信任后 `mergeConfigs` 会合并项目级 `mcp_servers`，其 `command` / `args` 由 `spawn` **直接执行，启动即发生**，不受沙箱约束（`config-selection.ts:202` 的 `warnUnsandboxedMcpServers` 自己承认了这点）。项目配置还能覆盖 `shellPath`，即此后每次 bash 工具调用所用的二进制。

- **后果**：仓库里放一份 `.reins/config.toml`，用户按 `y` 信任后即发生任意本地代码执行，而用户被告知「只是读文件」。
- **修复建议**：把 `mcp_servers`、`shellPath` 从「项目可覆盖」集合里剔除（`mergeConfigs` 改为白名单，只允许 `reasoning_effort`、`compaction`、`ui` 这类纯展示项）；若确实要保留，信任页必须改写文案并增加一次独立的「允许启动本地进程」确认。

---

## 四、P2 一般

| # | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- |
| P2-1 | `src/tools/truncate.ts:125-143` | `limitLineBytes` / `tailLineBytes` 从 `min(len, maxBytes)` 起逐字符收缩，每步重算整段 `byteLength` → O(n²)。实测**单行 10 万 CJK 字符耗时 1.4 秒**，且与行长无关地恒定阻塞主线程；`read`/`bash`/`job_output` 任一命中即整屏卡死 | 改为一次遍历累计字节数（按码位累加，超过上限即停），复杂度降到 O(n) |
| P2-2 | `src/session/jsonl-store.ts:243-244` | `parsed as Record<string, unknown>` 未判 null。会话文件里出现一行 `null` 时抛 `TypeError: Cannot read properties of null (reading 'type')`（已复现），`read()` 直接崩，而不是按设计计入 `skippedLines` | 解析后先 `typeof parsed === "object" && parsed !== null`，否则 `skippedLines += 1` |
| P2-3 | `src/mcp/service.ts:139-147` | 握手失败的 catch 只做 `#connectionAbort?.abort()`（stdio 下为 `undefined`），既不 `client.close()` 也不杀子进程。server 能启动但 `initialize` 不应答时，进程一直活着；`/mcps` 反复重连会累积 | catch 里补 `this.#client?.close(); this.#client = undefined;` |
| P2-4 | `src/checkpoint/git-snapshot.ts:221-233`、`:235-247` | 所有 git 调用只有 `maxBuffer`，**没有 `timeout`**。`git add -A` 在超大仓库/网络盘/索引损坏时会长时间不返回，而它被 `#serialized` 排队，后续 `capture`/`changes`/`restore` 全部阻塞，UI 直接冻住 | `run()` 加 `timeout: 60_000, killSignal: "SIGKILL"`，超时按 `#lastError` 处理 |
| P2-5 | `src/checkpoint/git-snapshot.ts:177-183` | `forget` 只 `update-ref -d`，注释说「对象留给 git 回收」，但全仓无任何 `git gc`/`prune` 调用。`MAX_ENTRIES=20` 只裁索引，`objects` 目录随每个回合的改动无限增长 | `#prune` 后异步跑一次 `git gc --auto --prune=now`，或每 N 次 capture 触发 |
| P2-6 | `src/workspace/trust.ts:103-111` | `recordTrust` 只删「完全相同」的一条记录，而 `findSavedDecision`（`:63-72`）逐级向上匹配。在 `~/work` 信任过之后，于 `~/work/evil` 执行 `--no-trust` 删的是不存在的条目，stderr 仍打印「已记录为不信任」，**下次启动项目配置照旧生效** | 写入显式 `untrusted` 清单并在查找时优先；或检测到结论来自祖先时直接报错说明要移除哪一条 |
| P2-7 | `src/workspace/trust.ts:63-72` | 信任向上继承一直走到文件系统根。在主目录 `cd ~ && reins` 点过一次信任，此后**任何**克隆到 `~/` 下的仓库都自动生效项目配置，不再弹信任页 | 向上查找终点限制在「最近的仓库根」（遇 `.git` 即停）；拒绝对家目录、盘符根写入信任 |
| P2-8 | `src/config/toml/parser.ts:302`→`:509`→`:537`；`src/config/json/parser.ts:85-140` | 两个解析器的值解析互相递归且**无深度计数**。`a = ` + `[`×5000 即 `RangeError: Maximum call stack size exceeded`；`wrapParseErrors` 只捕 `ConfigError`，RangeError 原样冒到顶层打印堆栈 | 维护 `#depth`，超过 64 层抛 `ConfigError`；`wrapParseErrors` 里把 `RangeError` 也转成 `ConfigError` |
| P2-9 | `src/config/file.ts:459` + `src/mcp/service.ts:118-121` | MCP `timeout` 只校验下界 `>= 1`。写 `timeout = 3000000` 时 `* 1000 = 3e9 > 2^31-1`，Node 打印 `TimeoutOverflowWarning` 并把延时截成 **1 ms**，表现为「远端工具全部立刻超时」，而配置看起来完全合理 | `readInteger` 增加上界（`timeout` 取 1..3600），并在 `service.ts` 里 `Math.min(seconds * 1000, 2**31 - 1)` 兜底 |
| P2-10 | `src/tui/runtime/transcript-state.ts:12-25`、`src/tui/runtime/turn.ts:420-426` | 每个 `text_delta` 都 `markTranscriptDirty`，而 100 ms 渲染帧会**重建整份对话流视图**（对全部历史重跑 `marked.lexer` + 折行，`wrapAtoms` 还是逐字符建 Span）。长会话下每帧成本 = O(全文)，帧率守不住 | 把视图拆成「已完成回合的缓存块 + 当前回合尾部」，只失效最后一段；`wrapAtoms` 改按段切分 |
| P2-11 | `src/cli/print-mode.ts:79-82`、`:97` | `event.summary`（工具结果首行，来自模型可控内容）与 `event.reason`（HTTP 错误正文）未经净化直接写 stderr。非交互模式没有备用屏，序列直接作用于使用者终端（清屏、改标题、写剪贴板） | 输出前过 `sanitizeLine()` |
| P2-12 | `src/tui/transcript/subagent.ts:59`、`:73-76` | `member.task`（来自模型生成的 `subagent` 参数）只做 `truncateToWidth`，未清洗控制字符就进帧，每帧重新生效 | 构造 `live` 时用 `sanitizeLine(member.task)` |
| P2-13 | `src/tui/runtime/lifecycle.ts:34-86` | `state.finished = true` 在第一行，`state.finish()` 在最后一行，中间有 6 处 `stdout.write` / `stdin.pause()` / `jobs.shutdown()`。任何一处抛错都会跳过 `finish()`，`runTui` 的 Promise 永不落定，进程带病挂住 | 释放逻辑包进 `try { ... } finally { state.finish(); }`，收尾阶段的写失败 try/catch 吞掉 |
| P2-14 | `src/config/paths.ts:32-34` + `src/tools/spill.ts:88-92` | `spillDir()` 用固定名 `reins-spill` 放在共享临时目录，不含 uid。多用户 POSIX 上他人可预建该目录（`mkdirSync` 对已存在目录的 `mode` 是 no-op）读取落盘的工具输出（可能含密钥），或预置同名符号链接让写入落到任意可写路径 | 目录名加 `process.getuid?.()`；创建前 `lstat` 校验属主且非链接；写入用 `flag: "wx"` |
| P2-15 | `src/config/initialize.ts:106` | `mkdirSync(configDir(), { recursive: true })` 未传 `mode`，实际是 `0777 & ~umask`（通常 0755）。`~/.reins` 下同时存放完整对话记录、工作区文件快照与插件 | 传 `mode: 0o700`；启动时对已存在目录 `chmodSync(0o700)`（忽略失败） |
| P2-16 | `src/cli/tui-mode.ts:826-829` + `src/workspace/walk.ts:260` | `files.list` 是 `[...fileEntries(workRoot, 20_000)]`，`walk()` 用 `readdirSync` 同步深度优先遍历，每层还要读 `.gitignore`。中大型仓库里第一次输入 `@` 会冻结整屏数百毫秒到数秒 | 补全索引改为启动后异步预热并缓存；未就绪时面板显示 `indexing…` |
| P2-17 | `src/tui/transcript/history.ts:185` | 回填的子代理组是 `{ startedAt: 0, durationMs: undefined }`，而 `subagentGroupHead` 在 `durationMs === undefined` 时用 `formatDuration(Date.now() - startedAt)` 现算 → 显示 `Subagents · 1 done (20700d)`。`tickActiveStatus` 只清理 running 组，回填组永远修不回来 | 改为 `durationMs: 0`，或只在组内有 running 成员时现算 |
| P2-18 | `src/tui/render/text.ts:174-176` 用于 `view/todo-card.ts:125,152`、`transcript/subagent.ts:132` | `sanitizeForDisplay` **有意**保留 `\t\n\r`（折行路径需要 `\n`），但任务卡、子代理清单摘要是**单行渲染点**。模型给的 `todo.content` 含换行/回车会让行错位，落在终端最后一行时触发滚动、后续光标行号失配 | 新增 `sanitizeSingleLine()`（剥 ESC + `\r\n\t` 折成空格），替换这三处的调用 |
| P2-19 | `src/checkpoint/git-snapshot.ts:149-174` | 只有 `#writeTree()` 在 `#serialized` 里；`#diff`、`rmWorkspacePath`、递归 `rmSync` 与 `git checkout` 全在队列外。恢复进行到一半时的 `capture` 要么撞 `index.lock`，要么把「删了一半」的工作区写成检查点 | 把 `restore` 整个方法体包进 `#serialized`；`checkout` 失败时重试一次并明确提示工作区可能不完整 |
| P2-20 | `src/checkpoint/git-snapshot.ts:109`、`:185-188` | shadow 仓库的 `info/exclude` 只写 `.git/`，`git add -A` 仍会读工作树的 `.gitignore`。`dist/`、`*.log`、`.env.local` 从不进快照，智能体删掉后撤销显示成功但文件永久消失 | 撤销结果文案明确「被忽略的文件不在检查点范围内」，并用 `git status --ignored` 提示存在不可恢复的改动 |
| P2-21 | `src/config/merge.ts:115-124` | 项目级 MCP server 与用户级**同名时整体替换**（`command`/`url`/`headers` 全换），与「项目只能加严」的原则不一致：MCP 定义是代码执行面，却被允许完全接管 | 同名直接 `ConfigError` 提示改名，或只允许项目新增不重名的条目 |
| P2-22 | `src/tools/shell.ts:239-261` | Windows 的 `killProcessTree` 只处理 `spawn` 的 **error 事件**，`taskkill` 以非零码退出时既不回调也不抛错——进程树根本没被杀掉，而调用方以为成功了。已实测复现：`sleep 30` 作业 `kill` 后 15 秒仍为 `running` | 监听 `killer.on("close", code => { if (code !== 0) child.kill("SIGKILL"); })`，并在 `job_output` 里对「已请求 kill 但仍在跑」给出明确提示 |
| P2-23 | `tests/tools/jobs.test.ts:68-87` | 该用例在第 81 行断言后直接 `jobs.shutdown()`，没有 `try/finally`。断言失败时 `sleep 30` 子进程无人回收，`JobManager` 的 `wait()` 保持事件循环活跃，**整个 `node --test` 进程挂住不退出**（实测 13 分钟无进展） | 用例体包 `try { ... } finally { jobs.shutdown(); }`；更根本的是修掉 P2-22 |

---

## 五、P3 建议

| # | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- |
| P3-1 | `src/mcp/transport.ts:99-114` | stdio 的 `buffer` 无上限，server 输出不含换行的大量字节时内存无界增长 | 超过 8 MB 未见换行即丢弃该行并 `report("Protocol line too long")` |
| P3-2 | `src/mcp/client.ts:154` | `if (typeof id !== "number") return;` — JSON-RPC 2.0 允许字符串 id，回包用字符串时永远匹配不上，请求挂到超时 | `String(id)` 归一后再查表 |
| P3-3 | `src/mcp/transport.ts:117` | `stderr.resume()` 后内容被丢弃，失败原因只剩 `exited (code 1)`。而 stdio server 最常见的失败（缺依赖、参数错）全写在 stderr | 保留末尾 4 KB 环形缓冲，附进 `onClose` 的 reason |
| P3-4 | `src/cli/index.ts:4` | `process.exitCode = await main(...)` 无 try/catch，装配阶段的非 `ConfigError` 异常以裸堆栈形式输出，没有 `reins:` 前缀 | 包一层 try/catch，输出 `reins: ${describeError(error)}` 并置 `exitCode = 1` |
| P3-5 | `src/llm/http.ts:42-52` | `proxyAgents` 是模块级 Map，只增不删，`ProxyAgent` 实例从不 `close()`；反复改代理配置会累积连接池 | 提供 `disposeProxyAgents()`，在配置热更新换代理时调用 |
| P3-6 | `src/tools/web-fetch.ts:264-270` | `url.hostname` 对 IPv6 字面量返回带方括号的 `[2606:...]`，`leadingHextets` 解析失败返回 `[]` → `first === undefined` → **所有 IPv6 字面量 URL 都被拒**。方向是 fail-closed，但公网 IPv6 站点完全不可达 | 校验前先剥掉首尾方括号 |
| P3-7 | `src/tools/builtin/write.ts:47-52` | `existsSync` 与 `statSync` 之间文件被删会抛 ENOENT（TOCTOU），未被 try 包住 | 用 `statSync(path, { throwIfNoEntry: false })` 一次调用 |
| P3-8 | `src/session/session.ts:204-206` | `entries()` 直接返回内部数组，`readonly` 只是编译期约束 | 返回 `[...this.#entries]` 或冻结副本 |
| P3-9 | `src/session/lock.ts:22-51` | 进程被强杀后锁文件残留，会话变为永久不可写，只能手工删。注释承认这是有意为之，但没有给出「持有者已死」的提示 | 至少在错误信息里附上 `kill -0 <pid>` 的判断建议 |
| P3-10 | `src/tools/builtin/find.ts:47-56` | `find` 的遍历循环完全不让出事件循环（`grep` 每 50 个文件让一次），10 万条目上限下会长时间阻塞 | 与 `grep` 对齐，每批 `await setImmediate` |
| P3-11 | `src/workspace/walk.ts:74` | `queue.shift()` 在数组上是 O(n)，宽目录树（BFS 队列可达数万）下退化为 O(n²) | 改用索引游标或双端队列 |
| P3-12 | `src/plugins/external.ts:49-63` | `join(directory, name)` 直接 `import`，不校验是否为普通文件、不校验 `realpath` 是否仍在插件目录内；且模块**顶层代码在 `readPlugin` 校验之前就执行** | `lstat` 过滤非普通文件 + `realpathSync` 后 `isPathInside` 校验；并在注释里写明「插件目录 = 完全信任的代码目录」，避免读者误以为有安全边界 |
| P3-13 | `src/plugins/registry.ts:1-5` | 层次倒置：插件层（通用宿主设施）直接 import 具体的 `bubblewrap.ts`、`seatbelt.ts`、`jsonl-store.ts`。新增后端就要改插件模块 | 把清单移到装配处 `cli/pipeline.ts`，插件层只保留 `PluginHost` 与类型 |
| P3-14 | `tests/tools/jobs.test.ts:68` | 偶发失败已在 5 轮中复现 2 次，但具体用例与根因已定位（P2-22/P2-23），此项仅保留作为「测试套件对失败不健壮」的记录 | 修 P2-22/P2-23 后该用例应稳定；建议 CI 里重复跑 3 轮留档 |
| P3-15 | `src/tui/input/keys.ts:264-267` | `editInput` 遇到 `\r` 立即 `return`，同一数据块里回车之后的字符被静默丢弃（快速输入、粘贴结束紧跟回车时可见） | `submit` 后把剩余部分回填到下一次输入 |
| P3-16 | `src/checkpoint/git-snapshot.ts:126` | `update-ref refs/reins/${id}` 未校验 `id`；`capture` 是 public 方法，`id` 含 `..` 或换行可写出意外 ref | 校验 `^[a-z0-9-]+$` |
| P3-17 | `src/version.ts:13-21` | `JSON.parse(readFileSync(...))` 无 try，`package.json` 缺失或损坏时抛原始 `ENOENT`/`SyntaxError`，调用点（MCP 握手、页脚）无兜底 | 整段包 try，失败回退 `"unknown"` |
| P3-18 | `src/shared/describe-error.ts:7-9` | 非 `Error` 一律 `String(error)`，`{code, message}` 这类结构化错误会丢掉 `message` | 非 Error 且是对象时优先取 `message` 字段 |
| P3-19 | `src/agent/review.ts:45-49` | `/review --base <ref>` 的 `ref` 直接进 `git diff` 的 argv，`--output=/path` 这类值会被 git 当作选项，可写任意文件（需使用者自己输入，非模型驱动） | 校验 `ref` 不以 `-` 开头 |

---

## 六、重复代码与架构问题

### 6.1 三套「路径是否在根内」判定，语义各不相同

| 位置 | 语义 |
| --- | --- |
| `src/workspace/boundary.ts:12` `isPathInside` | 只做 `relative` 判定，不解析符号链接、不做大小写归一 |
| `src/workspace/trust.ts:120` `samePath` | 做 Windows 小写归一，不做 realpath |
| `src/checkpoint/git-snapshot.ts:14` `samePath` + `:279` `workspacePath` | 又一份实现，第三套语义 |

这三处**都直接支撑安全判定**（沙箱边界、信任继承、检查点恢复范围）。改一处漏一处，就会让「信任」与「检查点」对同一目录给出不同结论。建议收敛到 `workspace/boundary.ts`，提供 `isPathInside` / `isSamePath` / `resolveRealPath` 三个原语。

### 6.2 三套 git 调用封装

`src/workspace/git.ts:18`（`execFileSync`，500 ms，忽略 stderr）、`src/workspace/walk.ts:240`（`spawnSync`，10 s，64 MB）、`src/checkpoint/git-snapshot.ts:221/235`（`execFile`，**无超时**，16 MB）。环境变量清理（`#baseEnv` 清 `GIT_DIR`/`GIT_INDEX_FILE`）只存在于一处，另外两处会继承父进程的 git 环境变量。建议抽 `shared/git.ts` 统一超时、env 与错误归一。

### 6.3 三处 snake/camel 别名处理

`src/config/keys.ts:11`、`src/config/file.ts:178-192`（`aliasPath` + `withAliases`）、`src/config/toml/document.ts:133`（`#aliasPath`）。回写侧与读取侧必须永远一致，现在靠人工同步——P0-1 正是这类不一致的温床。

### 6.4 其他

- **`messageOf` 三份**：`shared/describe-error.ts`、`checkpoint/git-snapshot.ts:309`、`checkpoint/service.ts:402`。
- **`config/file.ts` 462 行**同时承担词汇表、别名解析、校验与 MCP 子表解析，建议按 `mcp`/`compaction`/`ui` 拆子模块。
- **`Session.entries()` 与 `state()` 每次调用都重建数组**，TUI 逐帧读取时是无谓的分配（`fold.ts:60-69`）。

---

## 七、值得肯定的设计

审查中也确认了大量做得扎实的地方，这些不是客套：

1. **安全边界的单一入口**：所有工具（核心、MCP、插件）只能经 `ToolRegistry.call` 执行，校验 → 审批 → 执行 → 溢出处理是一条路径，插件没有旁路。
2. **只读标注按来源分级采信**：`policy.ts:133,154` 只对 `core`/`bundled` 采信 `readOnly`，外部插件不能给自己开免审批通道。这是一个很容易被忽略的正确决定。
3. **沙箱「宁可不能用，也不假装可用」**：`setup.ts:56-97` 逐个后端做真实探针，全部失败则拒绝启动，而不是静默降级到不隔离。
4. **路径边界处理符号链接与悬空链接**：`boundary.ts:38-84` 用 lstat + readlink 递归解析悬空链接，`MAX_LINK_DEPTH` 防环——这是同类实现里经常写错的地方。
5. **shell 引用统一走 POSIX 规则**：`shell-quote.ts` 明确拒绝按平台分叉，并说明了理由（cmd 风格的引号在 bash 里更弱），这是正确的取舍。
6. **web_fetch 的 SSRF 防护完整**：DNS 固定解析 + 按 IP 校验 + 同源重定向 + 内嵌 IPv4 的过渡技术段全覆盖。
7. **会话可重放**：提示词分段、工具声明、模型与思考等级都作为条目落盘，`foldEntries` 能精确重建当时的请求。
8. **错误信息质量高**：普遍带文件、行列、原始输入片段，且解释「为什么」而不是「是什么」。

---

## 八、整体质量评估

**总体评分：B+ / A-（工程完成度高，安全边界设计优秀，但存在一处会损坏用户数据的高危缺陷与若干边界收口不彻底的问题）**

**优势**：分层与依赖方向控制得很好——`agent`/`llm`/`tools`/`session`/`sandbox`/`permission` 各自的职责边界清晰，接口抽象（`LlmClient`、`SandboxBackend`、`SessionStore`、`ToolGate`、`ApprovalReviewer`）用得克制且到位，没有为抽象而抽象。注释质量在同类项目里属于上乘：解释的是「为什么这样选」而非复述代码，且多次预判了「如果按另一种写法会出什么问题」。类型使用严格，无 `any` 泄漏到核心路径，外部输入普遍先按 `unknown` 收窄。

**主要短板集中在三处**：

1. **唯一会静默破坏用户数据的模块是配置回写**（P0-1）。它缺少「写完回读校验」这一最基本的安全网，而它写的正是使用者唯一的一份全局配置。这一条应当最优先修复，并补上对应的回归测试。

2. **安全边界的「最后一公里」收口不彻底**。审批链、沙箱、路径判定的主干设计都很扎实，但边界输入的处理在支路上出现了遗漏：粘贴防护只覆盖单块（P1-1）、终端输出净化只在部分路径生效（P2-11/P2-12/P2-18）、信任页文案与实现不一致（P1-6）。这些都不是设计错误，而是「规则只实现了一次，但调用点没有全部改过来」。

3. **资源生命周期在长会话下会累积**。MCP 失败连接不回收子进程（P2-3）、检查点 git 无超时且对象永不 gc（P2-4/P2-5）、TUI 流式每帧全量重排（P2-10）、`@` 补全同步遍历（P2-16）。单次使用察觉不到，连续工作几小时后会表现为「越用越慢、越用越占盘」。

4. **进程管理的失败路径没有闭环**。`killProcessTree` 在 Windows 上只处理 `spawn` 错误、不检查 `taskkill` 的退出码（P2-22），于是「杀不掉」被静默当成「杀掉」——这既影响 `kill_job` 与退出清理，也让测试套件在失败时挂死（P2-23）。这类「操作没成功但没人知道」的路径比直接报错危险得多。

**建议的修复顺序**：P0-1（配置回写）→ P1-1/P1-3（安全边界与计费）→ P1-2/P1-4（并发与终端还原）→ P1-5/P1-6 → P2-22/P2-23（进程终止与测试健壮性）→ P2-3/P2-4/P2-5/P2-10（资源泄漏与性能）。P3 与重复代码可以在后续重构中随功能改动一并收敛。

---

## 九、修复状态

按上一节的顺序修复完成，未新增功能。

| 编号 | 状态 | 修复方式 |
| --- | --- | --- |
| P0-1 | 已修复 | `TomlDocument` 区分内联表与点号键两种父表形式：内联表把键并进那个值，点号键沿用点号键追加；`set()` 写完按实际落点回读核对，不一致就抛错且不改动原文 |
| P1-1 | 已修复 | 粘贴状态在输入分发入口统一推进（`pastingAfter`），四个模态分支改用 `interactiveText`；编辑器路径不再自行回写状态 |
| P1-2 | 已修复 | 子代理的消息表改为 `run()` 局部变量并按参数传入工具编排 |
| P1-3 | 已修复 | 串联中止信号前先看 `signal.aborted`，已中止则立即中止本次请求 |
| P1-4 | 已修复 | `SIGINT`/`SIGTERM`/`SIGHUP` 走同一套收尾；另加 `exit` 兜底只写终端还原序列；`cleanup()` 用 `try/finally` 保证 `finish()` 一定执行 |
| P1-5 | 已修复 | `grep` 先 `statSync` 判大小再读，读后仍复核一次长度 |
| P1-6 | 已修复 | 项目级配置不再能覆盖 `shellPath`、也不再能新增或替换 `mcp_servers`；信任页文案改成如实描述 |
| P2-3 | 已修复 | MCP 握手失败时关闭连接（进而杀掉 stdio 子进程）；transport 的 `close()` 容忍 pid 未就绪 |
| P2-4 | 已修复 | 检查点的 git 调用统一加 60 秒超时与 `SIGKILL` |
| P2-5 | 已修复 | 裁剪掉旧检查点后调用 `git gc --auto --prune=now` 回收不可达对象 |
| P2-10 | 已修复 | 对话流按回合做前缀缓存，流式输出每帧只重排最后一个回合；实测 201 回合会话每帧 45.7 ms → 3.67 ms |
| P2-22 | 已修复 | `killProcessTree` 等待 `spawn` 事件后再杀（pid 未就绪时 kill 会抛 EINVAL），检查 `taskkill` 退出码并重试，最终退回结束直接子进程。修复过程中还定位到第二个根因：`close` 要等所有 stdio 关闭才触发，命令带出的孙进程占住管道时进程早已退出也永远不判定结束——改用 `exit` 加 200 ms 宽限兜底 |
| P2-23 | 已修复 | 该用例改用 `try/finally` 收掉 `sleep`，断言失败不再把整个测试进程挂住 |

修复过程中额外发现并修掉的一处：`grep` 工具此前**没有任何单元测试**，已补齐镜像测试（`tests/tools/builtin/grep.test.ts`）。

P2-1（截断的 O(n²) 收缩）不在建议顺序内，未改动；它仍是一个恒定约 1.4 秒的主线程阻塞，建议下一轮优先处理。
