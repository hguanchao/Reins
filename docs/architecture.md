# Reins 架构:模块与职责

> 本文件是项目的模块职责图。行为配置的权威样例在 [config.toml](../examples/config.toml),
> 产商目录的模板在 [providers.json](../examples/providers.json)。

## 三条原则

1. **端点是数据,协议是代码** —— 一切端点与模型知识都在 `providers.json` 里,
   代码只含 wire 协议适配器,**零内置产商**。
2. **配置节即模块** —— `config.toml` 的注释分节与 `src/` 模块一一对应,
   每个配置键恰好有一个属主模块(见下表)。
3. **单向依赖** —— `cli → agent → 工具管线 → {config, catalog} → util`,
   无反向边;`ui/` 只消费事件。

## 两个配置文件

| 文件 | 职责 | 写法 |
|---|---|---|
| `~/.reins/config.toml` | 「缰绳怎么勒」:模型选择、请求参数、权限、用量、界面、MCP | 人手写 |
| `~/.reins/providers.json` | 「马从哪来」:端点、密钥、模型、定价 | 向导生成或人手写;schema 兼容 pi 的 models.json,**是唯一目录层** |

密钥三形态:`$ENV`(环境变量引用,未设变量拒绝启动)、字面量、`!command`
(请求时执行,结果不缓存)。解析统一走 `catalog/secrets.ts`;明文密钥永不进 config.toml。
每个 provider 条目必须自包含:`baseUrl + api + models` 缺一即校验报错并指明行号。

## 模块图

```
reins/
├── docs/                       # 设计文档
├── examples/                   # config.toml 与 providers.json 样例(可复制到 ~/.reins)
├── tests/                      # 与 src/ 一一镜像(与 src 同级)
├── src/
│   ├── main.ts                 # 进程入口,子命令路由
│   ├── cli/                    # 职责:命令行表面
│   │   ├── args.ts
│   │   └── commands/           # run.ts doctor.ts models.ts config.ts init.ts
│   ├── agent/                  # 职责:代理循环与轮次调度
│   │   ├── loop.ts             # 主循环;max_turns 在此执行
│   │   ├── turn.ts             # 单轮:assistant 消息 → 工具执行 → 追加
│   │   └── run.ts              # headless 单次任务编排
│   ├── llm/                    # 职责:模型调用(协议,非产商)
│   │   ├── stream.ts           # 统一 stream() 接口:流式 + 工具调用归一化
│   │   ├── usage.ts            # token 记账
│   │   ├── retry.ts            # max_retries
│   │   ├── proxy.ts            # 出站代理
│   │   └── adapters/           # openai-completions / openai-responses /
│   │                           # anthropic-messages / google-generative-ai
│   ├── catalog/                # 职责:providers.json 的加载与解析
│   │   ├── schema.ts           # 严格 zod 校验
│   │   ├── load.ts             # 加载 + provider/model 名称解析
│   │   └── secrets.ts          # 密钥三形态
│   ├── config/                 # 职责:config.toml 的加载与分层
│   │   ├── schema.ts           # smol-toml + zod,默认值,带行号的报错
│   │   └── layers.ts           # 全局 / 项目两层合并
│   ├── session/                # 职责:会话存储(JSONL 树)
│   │   ├── store.ts            # append-only,首行带版本号
│   │   ├── tree.ts             # 分支 / fork / 活动分支
│   │   └── compaction.ts       # compact_model 摘要
│   ├── context/                # 职责:上下文组装
│   │   ├── system.ts           # 系统提示词
│   │   └── agents-md.ts        # AGENTS.md / REINS.md 发现
│   ├── tools/                  # 职责:工具集
│   │   ├── registry.ts         # 注册表;每个工具自声明权限范围
│   │   └── read.ts edit.ts write.ts bash.ts grep.ts glob.ts fetch.ts
│   ├── permissions/            # 职责:缰绳(策略引擎)
│   │   ├── rules.ts            # 模式解析:bash() / read() / mcp() / web_fetch()
│   │   ├── engine.ts           # deny > ask > allow,先命中先定论,跨层
│   │   ├── approval.ts         # ask / auto / yolo;auto 走 review_model
│   │   └── sandbox.ts          # off / workspace / read-only 边界
│   ├── spill/                  # 职责:超大结果落盘
│   │   ├── policy.ts           # spill_threshold 判定,上下文留预览
│   │   └── store.ts            # 落盘 + locator
│   ├── mcp/                    # 职责:MCP 客户端
│   │   ├── client.ts
│   │   └── servers.ts          # 后台连接不挡启动;可禁用外部配置声明的 server
│   ├── tui/                    # 职责:全屏交互界面(chat 默认表面)
│   │   ├── app.ts              # 三区域状态机:按键分发、区块流、渲染调度
│   │   ├── blocks.ts           # 滚动区块模型:折叠/展开、缓存渲染
│   │   ├── markdown.ts         # 助手文本排版(标题/列表/引用/表格/代码栅栏)
│   │   ├── highlight.ts        # 零依赖代码高亮(语言表驱动)
│   │   ├── viewer.ts           # 全屏查看器(完整工具输出)
│   │   ├── editor.ts           # 输入行编辑(历史/斜杠/@ 文件补全)
│   │   ├── keys.ts             # 输入解码:按键/鼠标滚轮/括号粘贴
│   │   ├── files.ts            # 工作区文件索引(@ 补全数据源)
│   │   ├── screen.ts           # 备用屏、raw 模式、帧差分输出
│   │   ├── theme.ts            # 角色化主题(dark/light/mono + [ui.colors] 覆盖)
│   │   └── layout.ts           # 显示宽度、截断、折行(含 CJK)
│   ├── ui/                     # 职责:呈现
│   │   ├── printer.ts          # print 模式渲染(headless)
│   │   └── notify.ts           # [ui] notify
│   └── util/                   # 职责:通用工具,不依赖任何人
├── package.json                # name: reins;bin: reins
└── tsconfig.json
```

## 配置键 → 属主模块

| config.toml | 属主模块 | 备注 |
|---|---|---|
| `provider` / `model` | `catalog/load.ts` | 按名解析 providers.json 条目 |
| `context_window` `max_tokens` `reasoning_effort` | `llm/stream.ts` | 模型元数据优先,config 兜底 |
| `max_retries` | `llm/retry.ts` | 0 = 失败即停 |
| `proxy` | `llm/proxy.ts` | 显式空串 = 强制直连 |
| `compact_model` | `session/compaction.ts` | 省略用主模型 |
| `review_model` | `permissions/approval.ts` | auto 审批的审查模型 |
| `approval` | `permissions/approval.ts` | ask / auto / yolo |
| `sandbox` | `permissions/sandbox.ts` | off / workspace / read-only |
| `[permissions]` | `permissions/rules.ts` + `engine.ts` | 跨层 deny > ask > allow |
| `max_turns` | `agent/loop.ts` | 根会话不封顶 |
| `spill_threshold` | `spill/policy.ts` | 超长工具结果落盘留预览 |
| `[ui] notify` | `ui/notify.ts` | auto / bell / desktop / off |
| `[ui] theme` `[ui] colors` | `tui/theme.ts` | dark / light / mono;按角色覆盖取色 |
| `[mcp_servers]` | `mcp/servers.ts` | stdio / http / sse |

## 一次运行的流转

```
reins run "任务"
  └─ cli/commands/run.ts        解析参数
      └─ config + catalog       加载两文件,交叉校验,fail-fast
      └─ agent/loop.ts          主循环(以下每轮)
          ├─ context/            组装 system prompt + 活动分支
          ├─ llm/stream.ts       按 provider.api 分发适配器;usage 记账
          ├─ tools/registry.ts    逐个执行工具调用
          │   ├─ permissions/    先过策略引擎;ask 等用户,auto 走 review_model
          │   ├─ (工具本体)      执行
          │   └─ spill/policy    超长结果落盘,预览回填上下文
          ├─ session/store.ts    每步 append-only 落盘(审计)
          └─ ui/printer.ts       渲染 + notify
```

## 模块规则

- 每模块只暴露一个入口 barrel;禁止跨模块深导入。
- 外部副作用(磁盘 / 网络 / 子进程)集中在 `session / spill / llm / tools / mcp`。
- `ui/` 不含业务逻辑,只订阅事件。
- `tests/` 与 `src/` 一一镜像(与 src 同级)。
- 单包起步,模块边界即未来拆包边界,拆包时保持机械可迁移。
