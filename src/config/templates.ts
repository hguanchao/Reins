/**
 * 内置默认配置模板:首次启动时用于自动补全缺失的配置文件。
 *
 * 注释保持简短;取值即默认行为,示例端点可直接替换。
 */

export const DEFAULT_CONFIG_TOML = `# Reins 行为配置(注释行 = 可选配置与取值说明)

provider = "example-openai"     # providers.json 中的名称
model = "gpt-5.2"               # provider 下的模型 id

max_retries = 10                # 上游失败重试次数,0 = 失败即停
approval = "ask"                # ask | auto | yolo
sandbox = "off"                 # off | workspace | read-only
spill_threshold = 8192          # 超长工具结果落盘阈值,0 = 关闭

# context_window = 256000       # 模型窗口兜底(providers.json 未声明时)
# max_tokens = 8192             # 单次输出上限
# reasoning_effort = "medium"   # off | low | medium | high | xhigh | max
# proxy = ""                    # 出站代理,空串 = 强制直连
# compact_model = ""            # 压缩摘要模型,省略 = 主模型
# review_model = ""             # auto 审批审查模型,省略 = 主模型
# max_turns = 20                # 模型轮数上限,省略 = 不封顶

[permissions]                   # deny > ask > allow,先命中先定论
deny = []                       # 例:["bash(rm *)", "read(*.env)"]
ask = []                        # 例:["bash(git push *)"]
allow = []                      # 例:["bash(git status)"]

[ui]
notify = "auto"                 # auto | bell | desktop | off
theme = "dark"                  # TUI 主题:dark | light | mono(纯文本)

# [ui.colors]                   # 按角色覆盖主题取色:颜色名 / #rrggbb / 0-255
# accent = "#56b6c2"            # 品牌与强调(标题、提示符、选中项)
# userBar = "#dadada bg-#444444" # 用户消息条配色(文字色 + bg- 背景)
# ok = "green"                  # 成功状态
# warn = "bold yellow"          # 运行中与审批
# fail = "red"                  # 失败状态
# code = "#8ab4f8"              # 行内代码
# keyword = "1;35"              # 代码高亮关键字

# [mcp_servers.context7]        # MCP 示例:stdio 型
# command = "npx"
# args = ["-y", "@upstash/context7-mcp"]
`;

export const DEFAULT_PROVIDERS_JSON = `{
  "providers": {
    "example-openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "headers": {},
      "models": [
        {
          "id": "gpt-5.2",
          "name": "GPT-5.2",
          "contextWindow": 256000,
          "maxTokens": 8192,
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 1.25, "output": 10, "cacheRead": 0.125, "cacheWrite": 1.25 },
          "headers": {}
        }
      ]
    }
  }
}
`;
