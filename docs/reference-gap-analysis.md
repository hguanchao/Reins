# 参考项目功能对比与差距记录

2026-10-27 对照 5 个参考项目盘点 Reins 缺失的核心功能。参考项目当天所在版本:
codex `50983c7a`、deepseek-harness `22ddee3792`、grok-build `2bdd1d6`、opencode `4a85158e27`、
pi `842c731`。本文记录"别人有、我们没有"的结论与佐证位置,供排期参考;实现某个缺口时
以当时代码为准重新调研,不按本文照抄。

## 一、已对齐的能力(无需追赶)

以下核心项 Reins 均已实现,质量不输参考项目,个别项目(pi 无沙箱、无审批;dsh 无 checkpoint)
反而没有:

- 内置工具集:read/write/edit、bash(超时+后台)、ls/find/grep、todo、present_plan、
  job_output/kill_job、subagent,大结果落盘(spill)。
- 权限与安全:ask/auto/yolo 三种审批模式(auto 走审查模型)、off/workspace/read-only
  三档沙箱、realpath 路径边界防目录链接逃逸、workspace 信任门控。
- 会话:JSONL 树结构存储、resume/fork、80% 窗口自动压缩(边界不落在工具结果上)、
  用量与成本累计。
- 模型层:anthropic-messages / openai-completions / openai-responses 三协议适配器、
  指数退避重试、thinking/effort 阶梯、providers.json 目录与会话内切换。
- 扩展:MCP 客户端(stdio/SSE/HTTP)、插件 seam(可注册工具/命令/沙箱后端/会话存储)、
  skills 发现、AGENTS.md 系规则文件加载。
- 编排与交互:计划模式(只读闸门不可绕)、后台 bash 作业、checkpoint 影子 git 回滚、
  图片输入、print 模式、剪贴板与通知。

各家重度的差异化能力(codex 云任务与语音、grok Rhai workflow 与媒体生成、dsh PTC 与
browser-use 等)与"最小代码实现"原则相悖,明确不跟进。

## 二、核心缺口(多数参考项目视为必备)

按重要度排序。每条附参考项目中的佐证位置(均在 `reference/` 下)。

### 1. Windows 沙箱后端

沙箱后端只有 macOS Seatbelt 与 Linux bubblewrap(`src/sandbox/backends/`),而开发与
使用主力平台是 Windows——当前在 Windows 上沙箱实际只有 `off` 可用,bash 裸跑。
三家已实现:codex 整套 AppContainer + 受限 token + WFP 网络过滤
(`codex-rs/windows-sandbox-rs/`);grok-build 用 Windows ACL(`xai-grok-sandbox/`);
deepseek-harness 有 `sandbox-windows-acl` 包。结论:可行且必要,是所有缺口里最重的一个。

### 2. 持久化权限规则

现有审批模式与会话内"总是允许"都不落盘,重启即失效,做不到"本项目内 npm test 永远放行"。
opencode 有 `allow/ask/deny` 规则且用户选择可存为规则(`core/src/permission/`);
grok-build 有 `.grok/config.toml` 规则引擎,deny 永远赢、bash 按链式命令分段匹配、
危险命令表永不走前缀记忆(`xai-grok-*` 权限管线,docs/user-guide/22);codex 有
execpolicy 规则引擎(`codex-rs/execpolicy/`)。设计要点取自 grok:规则三来源
(项目配置 + CLI 参数 + 每次批准的"记住")、deny 优先、bash 危险命令绕过记忆化。

### 3. Headless 结构化输出与程序化接入面

`-p` print 模式只出纯文本。没有 JSON 事件流,就接不了 IDE、CI 自动化与二次开发。
四家的形态:codex `exec --json` 输出 JSONL 事件流;opencode 常驻 server + REST/事件流,
多客户端共享会话;pi `--mode json/rpc`(rpc 为双向 JSONL,面向 IDE)+ SDK;grok-build
原生 ACP server(`grok agent stdio`)。最小做法是先补"print 模式输出 JSONL 事件流",
server/ACP 等有需求再议。

### 4. Hooks(生命周期钩子)

插件目前只能注册工具与命令,挂不进生命周期。grok-build 有 15 类事件
(SessionStart/End、UserPromptSubmit、Pre/PostToolUse、Stop、Pre/PostCompact、
Subagent* 等),且直接兼容 Claude 与 Cursor 的 hooks 配置文件(`xai-grok-hooks/`);
codex 有独立 hooks crate(`codex-rs/hooks/`,事件在 `hooks/src/events/`);
deepseek-harness 有 hook 桥(`packages/experimental/hooks-*`)。Reins 的对应 seam
应落在插件契约上:宿主在生命周期点广播事件,插件与外部命令均可订阅。

### 5. Web search / web fetch 内置工具

codex、opencode、deepseek-harness、grok-build 四家均内置且 provider 可换
(dsh:`packages/web/tool-web`,可换 DeepSeek/Exa/Perplexity;opencode:
`core/src/plugin/websearch/`)。Reins 现在只能靠 MCP 外挂或 bash curl。若坚持
"最小内核、外挂增强"的定位可以不做,但属四家共识,记录在案。

### 6. 模型主动提问与运行中插话

两类交互均缺:

- `ask_user_question`/`question` 工具:模型在歧义处主动向用户要结构化决策
  (codex `request_user_input`、opencode `question`、grok 与 dsh 同名工具)。
- steering 与消息队列:回合进行中插话(下一轮生效)、追加消息排队
  (pi:Enter 插入 / Alt+Enter 排队 / Alt+Up 取回;grok mid-turn interject;
  opencode 会话队列)。

长回合任务里用户目前只能打断重说,这两条直接改善交互闭环。

### 7. MCP 工程化补齐

- 工具惰性发现:MCP 工具一多就撑爆上下文。四家的解法是元工具按需加载——
  codex `tool_search`(`core/src/tools/handlers/tool_search.rs`)、grok
  `search_tool`/`use_tool`、pi BM25 检索 + deferred 暴露、opencode codemode。
  Reins 目前全量注入注册表。
- MCP OAuth 登录:codex/grok/opencode/pi 均支持,Reins 的 transport 无认证。
- resources 读取:opencode 与 dsh 有列/读 MCP 资源的工具,Reins 只接工具。

### 8. Markdown 自定义 slash 命令

"一个 md 文件即一条命令"是四家通用入口:codex `~/.codex/prompts/*.md`、
pi prompt templates(支持 `$1` 参数)、opencode `command/*.md`、grok 把每个
skill 直接注册为 slash 命令。Reins 只认插件命令,普通用户没有零代码扩展入口。
与 skills 的差别:命令面向用户手敲,skills 面向模型按需取用;两者共存。

## 三、次级缺口(部分项目有,属增强项)

- **read_image/view_image 工具**:让模型主动读本地图片进上下文(codex `view_image`、
  dsh `read_image`、grok read_file 内含图片解析)。Reins 只有用户侧贴图入口。
- **持久 PTY / 交互式终端**:codex unified_exec + `write_stdin`、opencode
  persistent-pty、dsh `terminal_*`、grok `monitor` 流式事件。Reins 后台作业是
  一次性进程,无法向运行中的进程写 stdin。
- **apply_patch/patch 批量编辑**:codex 独立补丁协议、opencode `patch` 多文件编辑;
  Reins 只有单文件 str-replace,多文件重构靠多次调用。
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

## 四、建议优先级

按"补产品短板 + 顺平台"排:

- **P0**:Windows 沙箱后端;持久化权限规则;headless JSON 事件流。
- **P1**:hooks;ask_user 工具与 steering/队列;MCP tool_search;markdown 自定义命令。
- **P2**:三节所列增强项,按实际需求取用。

排序理由:Windows 沙箱是当前平台上的安全实洞;权限规则是审批体系的收口;
JSON 输出是自动化与生态的地基。P1 四项都是"扩展面"性质,可按插件需求逐步落。
