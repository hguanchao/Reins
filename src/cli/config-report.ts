import type { Config } from "../config/config-file.ts";
import type { ModelEntry, ProvidersConfig } from "../config/providers-file.ts";
import type { ModelSelection } from "../config/selection.ts";
import { displayWidth } from "../tui/text/width.ts";

/** 未声明的值就写「未声明」。用 0 或某个数字代替会让人以为程序知道真实情况。 */
const UNKNOWN = "未声明";

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
	if (model.reasoning) parts.push("支持思考等级");
	if (model.contextWindow !== undefined) parts.push(`上下文 ${model.contextWindow}`);
	if (model.maxTokens !== undefined) parts.push(`输出上限 ${model.maxTokens}`);
	return `  ${parts.join("  ·  ")}`;
}

function describeOptional(model: ModelEntry | undefined): string {
	return model === undefined ? "跟随主模型" : model.id;
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

	lines.push("配置文件");
	lines.push(row("config", input.configFile));
	lines.push(row("providers", input.providersFile));
	lines.push(row("REINS_HOME", input.reinsHome ?? "（未设置）"));
	lines.push("");

	lines.push("当前模型");
	lines.push(row("provider", config.provider));
	lines.push(row("model", config.model));
	lines.push(row("api", selection.model.api));
	lines.push(row("baseUrl", selection.model.baseUrl));
	lines.push(row("思考等级", config.reasoningEffort));
	lines.push(
		row("上下文窗口", windowReport(selection.model.contextWindow ?? config.contextWindow)),
	);
	lines.push(row("输出上限", formatNumber(selection.model.maxTokens ?? config.maxTokens)));
	lines.push(row("压缩模型", describeOptional(selection.compactModel)));
	lines.push(row("审查模型", describeOptional(selection.reviewModel)));
	lines.push("");

	lines.push("运行参数");
	lines.push(row("审批", config.approval));
	lines.push(row("沙箱", config.sandbox));
	lines.push(row("最大重试", String(config.maxRetries)));
	lines.push(row("落盘阈值", config.spillThreshold === 0 ? "关闭" : String(config.spillThreshold)));
	lines.push(row("子代理上限", config.maxTurns === undefined ? "子代理默认" : String(config.maxTurns)));
	lines.push(row("代理", config.httpProxy === undefined ? UNKNOWN : config.httpProxy || "强制直连"));
	lines.push("");

	lines.push(`可选模型（共 ${providersConfig.providers.reduce((total, item) => total + item.models.length, 0)} 个）`);
	for (const provider of providersConfig.providers) {
		for (const model of provider.models) {
			const mark = provider.id === config.provider && model.id === config.model ? "*" : " ";
			lines.push(`${mark}${describeModel(provider.id, model)}`);
		}
	}
	lines.push("");

	lines.push("插件");
	lines.push(row("停用", config.plugins.disabled.length === 0 ? "无" : config.plugins.disabled.join("、")));
	lines.push(row("已信任根", config.plugins.trusted.length === 0 ? "无" : config.plugins.trusted.join("、")));
	lines.push("");

	lines.push(`MCP server（共 ${config.mcpServers.length} 个）`);
	if (config.mcpServers.length === 0) {
		lines.push("  未配置");
	}
	for (const server of config.mcpServers) {
		const endpoint = server.type === "stdio" ? [server.command, ...server.args].join(" ") : (server.url ?? "");
		const state = server.disabled ? "已停用" : "启用";
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
	return value === undefined ? `${UNKNOWN}（不会自动压缩上下文）` : String(value);
}
