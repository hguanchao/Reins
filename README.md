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
| `~/.reins/config.toml` | 行为:模型选择、请求参数、权限、界面 | `docs/config.toml` |
| `~/.reins/providers.json` | 端点:baseUrl、api、密钥、模型与定价 | `docs/providers.example.json` |

要点:

- 每个 provider 条目必须自包含 `baseUrl + api + models`,缺一即报错;
- 密钥支持三种形态:`$ENV`(未设置时拒绝启动)、`!command`(请求时执行、不缓存)、字面量;
- 当前已实现的协议:`openai-completions`、`anthropic-messages`;

## 命令

| 命令 | 说明 |
|---|---|
| `reins run "任务" [--workspace 目录] [--session 会话文件]` | 执行一次任务 |
| `reins doctor [--no-network]` | 自检配置与端点连通性 |
| `reins config check \| show` | 校验 / 展示解析后的配置 |
| `reins models list [--provider 名称]` | 列出产商与模型 |
| `reins init [--force]` | 交互式初始化配置 |

环境变量 `REINS_HOME` 可覆盖配置目录(默认 `~/.reins`)。

## 开发

```sh
npm install
npm test          # node:test 单元测试
npm run typecheck # tsc --noEmit
```

开发规范见 `AGENTS.md`;模块职责图见 `docs/architecture.md`。

## 当前状态

M0 内核已完成:代理循环、六个内置工具(read / write / edit / bash / grep / glob)、
权限规则引擎与审批门、沙箱边界、会话 JSONL 存储与分支、超大结果落盘、
上下文压缩、审查模型(auto 审批)、MCP 客户端(stdio / http)、
协议适配器(openai-completions、anthropic-messages)、命令行入口与自检。
