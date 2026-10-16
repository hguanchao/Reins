import type { SessionEntry, SessionHeaderEntry } from "./port.ts";
import { describeUsage, sumUsage } from "./usage.ts";

/**
 * 把会话导出成 Markdown。
 *
 * 导出的是完整历史，不是当前上下文：被压缩掉的消息照样写出来，压缩点则单独标出来——读的人
 * 需要知道「模型当时看到的是什么」，而写下来的人需要知道「当时到底发生了什么」。因此这里
 * 按条目顺序走，不经过折叠。
 *
 * 工具结果与推理一律按引用块排版：它们常常是多行、带缩进甚至带反引号的内容，塞进围栏代码块
 * 会被内容里的围栏截断，而引用块只加一个前缀，多长都不会坏。
 */

const DIALOG_HEADING = "## 对话";
const COMPACTION_HEADING = "## 上下文压缩";
const USAGE_HEADING = "## 用量";

export function renderSessionMarkdown(
	header: SessionHeaderEntry | undefined,
	entries: readonly SessionEntry[],
): string {
	const lines: string[] = [];

	lines.push(`# 会话 ${header?.id ?? "（缺少会话头）"}`);
	lines.push("");
	if (header !== undefined) {
		lines.push(`- 开始：${header.timestamp}`);
		lines.push(`- 目录：${header.cwd}`);
		if (header.forkedFrom !== undefined) {
			lines.push(`- 分叉自：${header.forkedFrom.session} 的 ${header.forkedFrom.entry}`);
		}
	}
	lines.push(`- 条目：${entries.length}`);
	lines.push("");

	lines.push(DIALOG_HEADING);
	lines.push("");
	let empty = true;
	for (const entry of entries) {
		const block = renderEntry(entry);
		if (block.length === 0) continue;
		empty = false;
		lines.push(...block, "");
	}
	if (empty) lines.push("（还没有对话）", "");

	const compactions = entries.filter((entry) => entry.type === "compaction");
	if (compactions.length > 0) {
		lines.push(COMPACTION_HEADING, "");
		for (const entry of compactions) {
			if (entry.type !== "compaction") continue;
			lines.push(`### ${entry.timestamp}　${entry.provider}/${entry.model}`);
			lines.push("");
			lines.push(`覆盖 ${entry.covered.length} 条消息，压缩前约 ${entry.tokensBefore} token。`);
			lines.push("");
			lines.push(entry.summary);
			lines.push("");
		}
	}

	lines.push(USAGE_HEADING, "");
	lines.push(`- ${describeUsage(sumUsage(entries))}`);
	return `${lines.join("\n")}\n`;
}

function renderEntry(entry: SessionEntry): readonly string[] {
	switch (entry.type) {
		case "message":
			switch (entry.message.role) {
				case "user":
					return ["### 使用者", "", entry.message.content];
				case "assistant": {
					const lines: string[] = ["### 助手", ""];
					const text = entry.message.content
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("\n\n")
						.trim();
					const thinking = entry.message.content
						.filter((block) => block.type === "thinking")
						.map((block) => (block.type === "thinking" ? block.text : ""))
						.join("\n\n")
						.trim();
					const calls = entry.message.content.filter((block) => block.type === "toolCall");

					if (text.length > 0) lines.push(text, "");
					if (thinking.length > 0) lines.push(...quote("思考", thinking), "");
					if (calls.length > 0) {
						for (const call of calls) {
							if (call.type !== "toolCall") continue;
							lines.push(`调用工具 \`${call.name}\`：`, "", ...quote(null, JSON.stringify(call.arguments, null, 2)), "");
						}
					}
					while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
					return lines;
				}
				case "toolResult":
					return [
						`### 工具结果 ${entry.message.toolName}${entry.message.isError ? "（失败）" : ""}`,
						"",
						...quote(null, entry.message.content),
					];
			}
		case "system": {
			const changed = Object.entries(entry.sections).map(([name, body]) =>
				body === null ? `移除 ${name}` : `更新 ${name}`,
			);
			const tools: string[] = [];
			for (const tool of entry.toolsAdded ?? []) tools.push(`+${tool.name}`);
			for (const name of entry.toolsRemoved ?? []) tools.push(`-${name}`);
			const parts = [...changed, ...tools];
			return parts.length === 0 ? [] : [`> 提示词：${parts.join("、")}`];
		}
		case "model_change":
			return [`> 模型切换为 ${entry.provider}/${entry.model}`];
		case "effort_change":
			return [`> 思考等级切换为 ${entry.effort}`];
		case "usage":
			// 用量在末尾统一汇总，逐条列出来只会淹没对话
			return [];
		case "compaction":
			return [`> 上下文压缩：覆盖 ${entry.covered.length} 条消息，详情见后文`];
	}
}

/** 引用块。首行带标题时写成「**标题**」加换行，其余每行统一加前缀。 */
function quote(title: string | null, text: string): readonly string[] {
	const lines = text.split("\n");
	const prefixed = lines.map((line) => (line.length === 0 ? ">" : `> ${line}`));
	if (title === null) return prefixed;
	return [`> **${title}**`, ...prefixed];
}
