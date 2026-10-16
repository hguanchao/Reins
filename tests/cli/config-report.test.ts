import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatConfigReport } from "../../src/cli/config-report.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { parseModels } from "../../src/config/models-file.ts";
import { resolveSelection } from "../../src/config/selection.ts";
import { displayWidth } from "../../src/tui/text/width.ts";

const CONFIG_FILE = "config.toml";
const MODELS_FILE = "models.json";

const MODELS_SOURCE = JSON.stringify({
	providers: {
		local: {
			baseUrl: "http://localhost:8000/v1",
			api: "openai-completions",
			models: [{ id: "qwen2.5-coder:7b", contextWindow: 131072, maxTokens: 8192 }],
		},
	},
});

function report(configSource: string): string {
	const config = parseConfig(configSource, CONFIG_FILE);
	const models = parseModels(MODELS_SOURCE, MODELS_FILE);
	return formatConfigReport({
		configFile: CONFIG_FILE,
		modelsFile: MODELS_FILE,
		reinsHome: undefined,
		config,
		models,
		selection: resolveSelection(config, models, CONFIG_FILE, MODELS_FILE),
	});
}

describe("config check 的报告", () => {
	it("逐项列出与模型相关的生效值", () => {
		const text = report('provider = "local"\nmodel = "qwen2.5-coder:7b"\n');
		assert.ok(text.includes("provider      local"));
		assert.ok(text.includes("model         qwen2.5-coder:7b"));
		assert.ok(text.includes("api           openai-completions"));
		assert.ok(text.includes("上下文窗口    131072"));
		assert.ok(text.includes("输出上限      8192"));
	});

	it("未声明的量照实写，不代填数字", () => {
		const text = report('provider = "local"\nmodel = "qwen2.5-coder:7b"\n');
		assert.ok(text.includes("审查模型      跟随主模型"));
		assert.ok(text.includes("代理          未声明"));
		assert.ok(text.includes("子代理上限    子代理默认"));
	});

	it("落盘阈值为 0 时写「关闭」", () => {
		assert.ok(report('provider = "local"\nmodel = "qwen2.5-coder:7b"\nspill_threshold = 0\n').includes("落盘阈值      关闭"));
	});

	it("标出当前选中的模型，并列出全部可选模型", () => {
		const text = report('provider = "local"\nmodel = "qwen2.5-coder:7b"\n');
		assert.ok(text.includes("*  local/qwen2.5-coder:7b"));
		assert.ok(text.includes("可选模型（共 1 个）"));
	});

	it("中英混排的标签列按显示宽度对齐", () => {
		const lines = report('provider = "local"\nmodel = "qwen2.5-coder:7b"\n').split("\n");
		const starts = new Set<number>();
		for (const line of lines) {
			const match = /^ {2}(\S.*?)( {2,})(\S.*)$/.exec(line);
			if (match === null) continue;
			starts.add(2 + displayWidth(match[1]) + match[2].length);
		}
		assert.ok(starts.size > 0, "样例里应当有多行键值");
		assert.deepEqual([...starts], [16], "所有键值行的值都应从同一列开始");
	});

	it("没有 MCP server 时明确说明未配置", () => {
		assert.ok(report('provider = "local"\nmodel = "qwen2.5-coder:7b"\n').includes("未配置"));
	});
});
