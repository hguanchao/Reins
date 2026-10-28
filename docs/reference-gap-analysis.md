# 参考项目功能对比与差距记录

2026-10-27 对照 5 个参考项目盘点 Reins 缺失的核心功能。参考项目当天所在版本:
codex `50983c7a`、deepseek-harness `22ddee3792`、grok-build `2bdd1d6`、opencode `4a85158e27`、
pi `842c731`。本文记录"别人有、我们没有"的结论与佐证位置,供排期参考;实现某个缺口时
以当时代码为准重新调研,不按本文照抄。

## 一、已对齐的能力(无需追赶)

以下核心项 Reins 均已实现,质量不输参考项目,个别项目(pi 无沙箱、无审批;dsh 无 checkpoint)
反而没有:

- 内置工具集:read/write/edit/patch、bash(超时+后台)、terminal_start/write/read/kill/list、
  ls/find/grep、todo、present_plan、job_output/kill_job、subagent,大结果落盘(spill)。
- 权限与安全:ask/auto/yolo 三种审批模式(auto 走审查模型)、off/workspace/read-only
  三档沙箱、realpath 路径边界防目录链接逃逸、workspace 信任门控。
- 会话:JSONL 树结构存储、resume/fork、对话回退与分支切换、80% 窗口自动压缩(边界不落在
  工具结果上)、用量与成本累计。
- 模型层:anthropic-messages / openai-completions / openai-responses 三协议适配器、
  指数退避重试、thinking/effort 阶梯、providers.json 目录与会话内切换。
- 扩展:MCP 客户端(stdio/SSE/HTTP)、插件 seam(可注册工具/命令/沙箱后端/会话存储)、
  skills 发现、AGENTS.md 系规则文件加载。
- 编排与交互:计划模式(只读闸门不可绕)、后台 bash 作业、持久终端、checkpoint 影子 git
  回滚、图片输入、print 模式、剪贴板与通知。

各有各的重度差异化能力(codex 云任务与语音、grok Rhai workflow 与媒体生成、dsh PTC 与
browser-use 等),与"最小代码实现"原则相悖,不跟进。

## 二、已决策的缺口(2026-10-28 复核后收缩)

初版列了 8 条核心缺口。复核后按「是否解决真实痛点、能否用最小代码实现、是否与最小内核定位
冲突」重新过了一遍,结论如下。判断依据写在每条后面,便于日后翻回来重议。

### 已完成

**Headless JSON 事件流。** `reins -p --json` 把事件按行写成 JSON,标准输出只放事件,标准错误
仍留给装配阶段的提示。`tool_end` 不带结果全文与结构化结果——前者动辄几十 KB,后者不是这个
协议的形状。事件集合就是 `AgentEvent` 本身,所以新增事件类型时协议自动跟上。

**会话回退与分支导航。** 会话文件仍是只追加的 JSONL,回退与切换只追加一条 `branch` 标记:
`parentId` 指向新的接续点,旧分支一个字节都不动。`/rewind` 列出当前路径上的用户消息,选中后
对话截断到它之前并把原文放回输入框;`/branches` 列出全部叶子并在它们之间切换。会话状态始终
从当前叶子的路径重放,重启后仍停在最后写下的分支上。

**持久终端。** `terminal_start` 启动一个跨工具调用存活的进程,`terminal_write` 向它的 stdin
写输入,`terminal_read` 增量读取输出,`terminal_kill` 结束整棵进程树。实现走管道而不是 PTY:
真正的 PTY 需要原生依赖,与「无构建产物、开箱可用」冲突;全屏 TUI 程序不支持,REPL、dev
server 与测试监听这类只需要 stdin 的场景不受影响。终端只活在当前进程里,退出时统一终止。

**多文件补丁。** `patch` 一次接收跨文件的精确文本替换,先把所有目标文件读入并校验,再统一
写入:任何一条 oldText 找不到、不唯一或重叠,一个文件都不动。匹配、唯一性与重叠判定与
`edit` 共用同一份实现。

### 明确不做

**Windows 沙箱后端。** 初版结论"grok-build 用 Windows ACL"是错的:grok 的沙箱后端只有
`seatbelt.rs`(macOS),`detect.rs` 里写死 `no per-command sandbox backend for {os}: v1 has
Seatbelt on macos only`。codex 与 deepseek-harness 都走**受限令牌**路线(WRITE_RESTRICTED +
Low 完整性标签 + DACL/SACL 编辑),必须 FFI 调 Win32,并各自附带 AppContainer、DPAPI、卸载
程序等外围设施。deepseek-harness 自己的已知限制里有一条直接与 Reins 冲突:受限子进程的管道
式 stdio 会 EPERM,而 bash 工具靠管道抓输出。`reference/` 中没有任何项目用 `icacls` 做隔离,
纯 Node 路线做不出真正有效的写隔离,只能做出"看起来开着"的一层——那正是沙箱铁律要排除的
情形。当前行为是**失败即拒绝**(Windows 上 `sandbox = workspace` 会拒绝执行命令),没有安全
漏洞,只是功能缺失。

**持久化权限规则。** 技术上可行且不复杂,但产品语义与现有设计冲突:审批方式有 `ask`、`auto`、
`yolo` 三档,`auto` 已经用审查模型代替逐次确认;再把"本项目内某条命令永远放行"落盘,等于
在审查模型之外又开了一条静态放行通道,规则优先级、与 deny 表的关系、跨项目共享与否都要
重新定义。收益(少点几次确认)不抵这套复杂度,暂缓。

**MCP tool_search(惰性发现)。** 在安全边界上加一层间接调用:能不能执行某个远端工具,从
"静态注册表里有没有"变成"检索结果里有没有"。要防住这一点,工具检索器就必须只能检索、不能
执行,代码量与判断难度都翻倍。MCP 工具多到撑爆上下文的场景,用 `disabled` 关掉几个 server
即可解决。

**MCP OAuth 登录。** 面向公有云 MCP 服务。Reins 以本地 stdio 与自建 HTTP 端点为主,headers
里放 token 已够用;完整授权码流程 + token 持久化与刷新 + 浏览器回调,与收益不匹配。

**MCP resources 读取。** 使用率低;真有需求写一个插件即可,属外部增强,不进内核。

**Web search / fetch 内置工具。** MCP 生态已有大量实现,一行配置即可接入。内置成本(网页
转发、HTML 清洗、编码、分页)不小,且会往审批链里加入一类难以判断风险的 openWorld 调用。

**模型主动提问(ask_user_question)。** Reins 的 Plan 模式已覆盖同一场景:歧义处把不确定写成
计划交给使用者审批,比弹结构化问题表单更可审查。print 模式没有人可答,只能填默认值,违反
"不确定就按最保守的一侧处理"。

### 例外项(按需再做)

**Hooks。** 15 类生命周期事件是 grok 要同时兼容 Claude 与 Cursor 配置格式带来的负担。Reins
的实际需求可以缩到 PreToolUse / PostToolUse 两个点(如"改完 .ts 跑 lint"),完整形态不做。

**Markdown 自定义 slash 命令。** 与 skills 功能重叠:skills 已覆盖"模型按需取用",而命令
面向"人反复手敲同一段话",后者用历史记录临时应付得住。等真实抱怨再说。

### 已在本轮之前就具备

**steering 与消息队列。** 初版记录成缺口,实际 TUI 早已实现:回合进行中提交的消息排进队列、
本轮收尾后逐条自动发送、Alt+Up 取回、Alt+Down 丢弃、Esc 中止并立即发送队首、切换会话清空
队列。本轮只补了最后一处缺口:队列超过可见条数(3)时给一句提示,而不是静默接受。

mid-turn 插话(消息立刻注入当前回合的工具循环)**不做**:它会打破 `TurnDriver` 的核心不变量
——回合内上下文只由已写入会话的消息组成。一旦插进去,`#buildRequest` 就不再等于重放会话的
结果,这个项目最可贵的属性也就没了。

## 三、次级缺口(部分项目有,属增强项)

- **read_image/view_image 工具**:让模型主动读本地图片进上下文(codex `view_image`、
  dsh `read_image`、grok read_file 内含图片解析)。Reins 只有用户侧贴图入口。
- **review 审查子代理**:codex 有专用 review 会话(`/review`、`codex exec review`,
  支持 --staged/--base/--commit)。
- **git worktree 集成**:codex/grok/opencode/dsh 均有(worktree 创建、gc、隔离子代理)。
- **模型 failover**:codex 重试预算耗尽后切备用 provider(`core/src/client.rs`);
  Reins 只有重试,无跨模型降级。
- **子代理预设角色与定义文件**:opencode 内置 explore/plan 等角色;grok 支持
  `.grok/agents/*.md` 定义(name/tools/permissionMode),深度限制同为 1。
  Reins 的 subagent 是纯泛用型。
- **AGENTS.md 嵌套发现与 /init**:codex/grok/opencode 均逐级(向下或向上)发现
  嵌套目录的规则文件,codex 有 `/init` 生成;Reins 只读项目根一级。
- **skill 直调**:pi `/skill:name`、grok skill 即命令;Reins 的 skill 只能由模型
  自行读取。
- **跨 provider 中途换模型**:pi 支持保留完整上下文的 handoff;Reins 换模型仅对
  后续请求生效(上下文本身可延续,但无协议差异的块翻译保证)。
- **会话导出/分享**:pi `/export` HTML/JSONL、`/share` 在线 viewer;opencode share。

## 四、剩余事项

收缩之后仍有价值的是:

- **PreToolUse / PostToolUse 两个钩子点**:挂着跑 lint、格式化这类"改完就做"的事。
- **第三节的次级缺口**:按实际需求取用,不排期。

Windows 沙箱与持久化权限规则若日后重议,先确认平台是否已有可用的受限令牌手段(例如宿主本身
就以受限身份运行),否则不启动。

