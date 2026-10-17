import type { Config } from "../config/config-file.ts";
import type { ModelCost, ModelEntry, ProvidersConfig } from "../config/providers-file.ts";
import type { ModelSelection } from "../config/selection.ts";
import { displayWidth } from "../tui/text/width.ts";

/** 未声明的值就写「未声明」。用 0 或某个数字代替会让人以为程序知道真实情况。 */
const UNKNOWN = "not declared";

/** 标签列的宽度，按显示列数算而不是字符数：中文标签占两列。 */
const LABEL_WIDTH = 14;

function row(label: string, value: string): string {
	return `  ${label}${" ".repeat(padTo(LABEL_WIDTH - displayWidth(label)))}${value}`;
}

function padTo(columns: number): number {
	return columns > 0 ? columns : 1;
}

function describeModel(providerId: string, model: ModelEntry): string {
	const parts = [`${providerId}/${model.id}`, model.api, model.baseUrl];
	if (model.reasoning) parts.push("supports reasoning levels");
	if (model.input.includes("image")) parts.push("supports images");
	if (model.contextWindow !== undefined) parts.push(`context ${model.contextWindow}`);
	if (model.maxTokens !== undefined) parts.push(`max output ${model.maxTokens}`);
	return `  ${parts.join("  ·  ")}`;
}

/** 单价按每百万 token 报，与配置文件里的口径一致。 */
function describeCost(cost: ModelCost | undefined): string {
	if (cost === undefined) return `${UNKNOWN} (tokens only, no cost)`;
	return (
		`input $${cost.input}  output $${cost.output}  ` +
		`cache read $${cost.cacheRead}  cache write $${cost.cacheWrite}  per million tokens`
	);
}

function describeOptional(model: ModelEntry | undefined): string {
	return model === undefined ? "follows main model" : model.id;
}

/**
 * 把校验结果整理成一段可读的文本。
 *
 * 目的是让人一眼确认「程序到底读到了什么」：配置写错的常见情形不是语法错，而是写对了
 * 语法但没生效，所以这里把生效值逐项列出来，未声明的也照实写出来。
 */
export function formatConfigReport(input: {
	readonly configFile: string;
	readonly providersFile: string;
	/** 环境变量覆盖值；未设置时传 undefined，由调用方读取，保持本函数可测 */
	readonly reinsHome: string | undefined;
	readonly config: Config;
	readonly providersConfig: ProvidersConfig;
	readonly selection: ModelSelection;
}): string {
	const { config, providersConfig, selection } = input;
	const lines: string[] = [];

	lines.push("Config files");
	lines.push(row("config", input.configFile));
	lines.push(row("providers", input.providersFile));
	lines.push(row("REINS_HOME", input.reinsHome ?? "(not set)"));
	lines.push("");

	lines.push("Current model");
	lines.push(row("provider", config.provider));
	lines.push(row("model", config.model));
	lines.push(row("api", selection.model.api));
	lines.push(row("baseUrl", selection.model.baseUrl));
	lines.push(row("reasoning", config.reasoningEffort));
	lines.push(
		row("context", windowReport(selection.model.contextWindow ?? config.contextWindow)),
	);
	lines.push(row("max output", formatNumber(selection.model.maxTokens ?? config.maxTokens)));
	lines.push(row("pricing", describeCost(selection.model.cost)));
	lines.push(row("input modes", selection.model.input.join(", ")));
	lines.push(row("compact model", describeOptional(selection.compactModel)));
	lines.push(row("review model", describeOptional(selection.reviewModel)));
	lines.push("");

	lines.push("Runtime");
	lines.push(row("approval", config.approval));
	lines.push(row("sandbox", config.sandbox));
	lines.push(row("max retries", String(config.maxRetries)));
	lines.push(row("spill", config.spillThreshold === 0 ? "off" : String(config.spillThreshold)));
	lines.push(row("subagent", config.maxTurns === undefined ? "default" : String(config.maxTurns)));
	lines.push(row("proxy", config.httpProxy === undefined ? UNKNOWN : config.httpProxy || "force direct"));
	lines.push("");

	lines.push(`Models (${providersConfig.providers.reduce((total, item) => total + item.models.length, 0)} total)`);
	for (const provider of providersConfig.providers) {
		for (const model of provider.models) {
			const mark = provider.id === config.provider && model.id === config.model ? "*" : " ";
			lines.push(`${mark}${describeModel(provider.id, model)}`);
		}
	}
	lines.push("");

	lines.push("Plugins");
	lines.push(row("disabled", config.plugins.disabled.length === 0 ? "none" : config.plugins.disabled.join(", ")));
	lines.push(row("trusted roots", config.plugins.trusted.length === 0 ? "none" : config.plugins.trusted.join(", ")));
	lines.push("");

	lines.push(`MCP servers (${config.mcpServers.length} total)`);
	if (config.mcpServers.length === 0) {
		lines.push("  none configured");
	}
	for (const server of config.mcpServers) {
		const endpoint = server.type === "stdio" ? [server.command, ...server.args].join(" ") : (server.url ?? "");
		const state = server.disabled ? "disabled" : "enabled";
		lines.push(`  ${server.name}  ${server.type}  ${state}  ${endpoint}`);
	}

	return `${lines.join("\n")}\n`;
}

function formatNumber(value: number | undefined): string {
	return value === undefined ? UNKNOWN : String(value);
}

/**
 * 上下文窗口除了数值，还要说清它有没有用：上限未知时无法判断「快满了」，自动压缩也就无从
 * 触发，而这件事只看一个「未声明」是看不出来的。
 */
function windowReport(value: number | undefined): string {
	return value === undefined ? `${UNKNOWN} (context is never compacted automatically)` : String(value);
}
