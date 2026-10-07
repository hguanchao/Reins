# Reins

可控优先的编程智能体:审批、审计、边界是它的本体。

- **端点是数据,协议是代码**:代码中零内置产商,一切端点与模型都在 `providers.json` 中声明。
- **配置节即模块**:每个配置项恰好有一个属主模块(见 `docs/architecture.md`)。
- **全自研**:不照搬任何既有项目代码。

## 快速上手

要求 Node.js >= 22.18。

```sh
# 1) 初始化配置(交互式;也可手动创建 ~/.reins/providers.json 与 ~/.reins/config.toml)
node src/main.ts init

# 2) 自检:配置、目录、密钥、端点连通性
node src/main.ts doctor

# 3) 执行一次任务
node src/main.ts run "把 README 里的错别字修一下" --workspace .
```

## 配置文件

| 文件 | 职责 | 样例 |
|---|---|---|
| `~/.reins/config.toml` | 行为:模型选择、请求参数、权限、界面 | `examples/config.toml` |
| `~/.reins/providers.json` | 端点:baseUrl、api、密钥、模型与定价 | `examples/providers.json` |

要点:

- 每个 provider 条目必须自包含 `baseUrl + api + models`,缺一即报错;
- 密钥与请求头值支持三种形态:`$ENV`(未设置时拒绝启动)、`!command`(请求时执行、不缓存)、字面量;
- 请求头在 provider 或模型层级配置,例:`"headers": { "X-Custom": "$CUSTOM_VAR" }`;
- 当前已实现的协议:`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`;

## 命令

| 命令 | 说明 |
|---|---|
| `reins run "任务" [--workspace 目录] [--resume 会话 id] [--trust]` | 执行一次任务 |
| `reins chat [--workspace 目录] [--plain] [--trust]` | 交互式会话:默认全屏 TUI,`--plain` 纯文本(裸命令 `reins` 亦可) |
| `reins sessions list [--limit 数量]` | 列出历史会话 |
| `reins trust [list \| add 目录 \| remove 目录]` | 查看 / 授权 / 撤销目录信任 |
| `reins doctor [--no-network]` | 自检配置与端点连通性 |
| `reins config check \| show` | 校验 / 展示解析后的配置 |
| `reins models list [--provider 名称]` | 列出产商与模型 |
| `reins init [--force]` | 交互式初始化配置 |

配置目录固定为 `~/.reins`,不提供环境变量覆盖。

## 开发

```sh
npm install
npm test          # node:test 单元测试
npm run typecheck # tsc --noEmit
```

开发规范见 `AGENTS.md`;模块职责图见 `docs/architecture.md`。

## 当前状态

内核已完成:代理循环、六个内置工具(read / write / edit / bash / grep / glob)、
权限规则引擎与审批门、沙箱边界、目录信任(项目层配置与项目说明文件须先授权)、
会话 JSONL 存储与分支、超大结果落盘、
上下文压缩、审查模型(auto 审批)、MCP 客户端(stdio / http / sse)、
四个协议适配器(openai-completions、openai-responses、anthropic-messages、google-generative-ai)、
会话管理、命令行入口与自检。

全屏 TUI(chat 默认表面)已完成:

- **排版**:助手回复按 markdown 渲染(标题、列表、引用、表格、行内样式),
  代码栅栏带画框与语法高亮(js/ts、json、python、bash、go、rust、sql、yaml、toml 等,零依赖);
  header 置顶带、输入框边框与主区右侧滚动条;
- **工具输出**:默认折叠为一行,`Ctrl+E` 展开预览,`Ctrl+O` 全屏查看器翻阅完整输出;
- **@ 文件选择器**:输入 `@` 触发工作区文件补全,文件名前缀 > 包含的排序,Tab 选中;
- **鼠标与粘贴**:滚轮滚动历史,括号粘贴(bracketed paste)下多行粘贴不会误发送;
- **主题**:`[ui] theme = dark | light | mono`,配色全局固定,不可逐项配置。
- **目录信任**:项目自带的 `.reins/config.toml` 能覆盖审批、沙箱、权限与 MCP,
  `REINS.md`/`AGENTS.md` 会被写进系统提示词,因此默认都不生效;命中 `[trust].trusted`
  里的目录模式才加载。进入未信任目录时交互终端先出信任页(逐条列出会被覆盖的配置,
  以及会被注入的说明文件),同意后把该目录写进 `~/.reins/config.toml`;无 TTY 则按未信任处理。

快捷键:`↑/↓` 历史 · `@` 文件 · `Tab` 补全 · `Ctrl+J` 换行 · `Ctrl+O` 查看 ·
`Ctrl+E` 展开 · `Ctrl+C/Esc` 中断 · `PgUp/PgDn`/滚轮 滚动。
