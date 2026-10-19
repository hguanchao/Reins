import { mkdirSync, writeFileSync } from "node:fs";

import { configDir, configFilePath, providersFilePath } from "./paths.ts";

/**
 * 首次启动时补齐配置模板。
 *
 * 只补缺失的文件：使用者已经写过的配置一律不动。模板本身是一份能通过校验的最小配置，
 * provider 与 model 指向同一份示例，改成自己的端点后即可运行。
 */

const CONFIG_TEMPLATE = `# Reins 配置模板。provider 与 model 必须对应 providers.json 里的条目。
provider = "example"
model = "example-model"

# 思考等级：off | low | medium | high | xhigh | max
reasoning_effort = "medium"

# providers.json 未声明 contextWindow 时用这里兜底
# context_window = 128000

# 单次输出上限
# max_tokens = 8192

# 上游失败重试次数；0 = 失败即停
# max_retries = 10

# 审批方式：ask | auto | yolo
# approval = "ask"

# 沙箱模式：off | workspace | read-only
# sandbox = "off"

# 工具结果超过这个字符数落盘；0 = 关闭
# spill_threshold = 8192

# 压缩摘要与审查专用模型，必须是同一 provider 下的模型 id
# compact_model = "example-model"
# review_model = "example-model"

# [ui]
# notify = "auto"                  # auto | bell | desktop | off
`;

const PROVIDERS_TEMPLATE = `{
  "providers": {
    // 键名就是 config.toml 里的 provider 值
    "example": {
      "name": "Example Provider",
      // 接口根；openai-completions 会再拼 /chat/completions
      "baseUrl": "https://api.example.com/v1",
      // openai-completions | openai-responses | anthropic-messages
      "api": "openai-completions",
      // 支持字面值、$ENV_VAR / \${ENV_VAR}、或 "!命令" 取密钥
      "apiKey": "$EXAMPLE_API_KEY",
      "models": [
        {
          // 必须与 config.toml 里的 model 一致
          "id": "example-model",
          "name": "Example Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192
          // 单价可选；写的话 input/output/cacheRead/cacheWrite 四项都要写
        }
      ]
    }
  }
}
`;

export interface InitializeConfigOptions {
	/** 是否允许创建默认位置的 config.toml */
	readonly config: boolean;
	/** 是否允许创建默认位置的 providers.json */
	readonly providers: boolean;
}

/**
 * 创建缺失的配置模板，返回实际新建的文件。
 *
 * 用排他写入（wx）而不是先判断再写：两者之间可能有另一个实例同时启动，排他写入让竞争
 * 的一方自然失败，不会覆盖刚写好的内容。文件已存在不算错误，直接跳过。
 */
export function initializeConfigFiles(options: InitializeConfigOptions): readonly string[] {
	if (!options.config && !options.providers) return [];

	mkdirSync(configDir(), { recursive: true });
	const created: string[] = [];
	if (options.config) {
		const file = configFilePath();
		if (writeNew(file, CONFIG_TEMPLATE)) created.push(file);
	}
	if (options.providers) {
		const file = providersFilePath();
		if (writeNew(file, PROVIDERS_TEMPLATE)) created.push(file);
	}
	return created;
}

function writeNew(file: string, content: string): boolean {
	try {
		writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if (isExistsError(error)) return false;
		throw error;
	}
}

function isExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "EEXIST"
	);
}
