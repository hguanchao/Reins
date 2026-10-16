import type { SessionEntry, SessionHeaderEntry } from "../session/port.ts";
import type { SessionListing } from "../session/store.ts";
import { describeUsage, sumUsage } from "../session/usage.ts";

/**
 * 会话的几个文字报告：清单、详情、条目摘要。
 *
 * 纯文本，因为使用者是隔着终端看的：`sessions list` 用来认出是哪个会话，`sessions show`
 * 用来找到某一条的下标（分叉要从那里开始）。两者都只读，不看上下文里还剩什么——被压缩掉的
 * 历史照样显示，它仍在文件里。
 */

/** 时间按本地时间显示：文件里存的是标准时间，但看的人只关心「什么时候」。 */
function localTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number): string => String(value).padStart(2, "0");
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

function clockTime(iso: string): string {
	const text = localTime(iso);
	return text.slice(11);
}

/** 会话清单。 */
export function formatSessionList(listings: readonly SessionListing[]): readonly string[] {
	if (listings.length === 0) return ["这个目录下还没有会话。"];

	const lines: string[] = [];
	for (const listing of listings) {
		const title = listing.title === undefined || listing.title.length === 0 ? "（还没有对话）" : listing.title;
		const fork = listing.forkedFrom === undefined ? "" : `　↳ 分叉自 ${listing.forkedFrom.session}`;
		lines.push(
			`${localTime(listing.updatedAt)}  ${listing.id}  ${String(listing.entryCount).padStart(4)} 条  ${title}${fork}`,
		);
	}
	lines.push("", "用 reins sessions show <标识> 看详细条目，用 reins --resume <标识> 接续。");
	return lines;
}

/** 会话详情：头信息、父会话链与逐条摘要。 */
export function formatSessionDetail(header: SessionHeaderEntry | undefined, entries: readonly SessionEntry[]): readonly string[] {
	const lines: string[] = [];
	if (header === undefined) {
		lines.push("会话文件缺少首行（会话头），只能列出条目。");
	} else {
		lines.push(`会话 ${header.id}`);
		lines.push(`  目录：${header.cwd}`);
		lines.push(`  开始：${localTime(header.timestamp)}`);
		if (header.forkedFrom !== undefined) {
			// 父会话链从这里往上追：那个会话的头里同样记着它的父会话
			lines.push(`  分叉自：${header.forkedFrom.session} 的 ${header.forkedFrom.entry}`);
		}
	}
	lines.push(`  条目：${entries.length}`);

	const leaf = entries[entries.length - 1];
	if (leaf !== undefined) lines.push(`  当前位置：${leaf.id}（分叉或接续从这里开始）`);

	const usage = sumUsage(entries);
	if (usage.requests > 0) {
		// 被压缩掉的历史同样计在里面：那些 token 确实花掉了
		lines.push(`  用量：${describeUsage(usage)}`);
	}

	lines.push("", "标识      时间       类型        内容");
	for (const entry of entries) {
		lines.push(
			`${entry.id}  ${clockTime(entry.timestamp)}  ${entry.type.padEnd(10)}  ${summarize(entry)}`,
		);
	}
	return lines;
}

/** 一条条目的摘要。够认出「这是哪一步」就行，完整内容在文件里。 */
export function summarize(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			switch (entry.message.role) {
				case "user":
					return `使用者：${clip(entry.message.content)}`;
				case "assistant": {
					const text = entry.message.content
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join(" ");
					const calls = entry.message.content.filter((block) => block.type === "toolCall");
					const parts: string[] = [];
					if (text.trim().length > 0) parts.push(clip(text));
					if (calls.length > 0) {
						parts.push(`调用 ${calls.map((call) => (call.type === "toolCall" ? call.name : "")).join("、")}`);
					}
					return `助手：${parts.join("；")}`;
				}
				case "toolResult":
					return `${entry.message.isError ? "工具失败" : "工具结果"} ${entry.message.toolName}：${clip(entry.message.content)}`;
			}
		case "system": {
			const names = Object.entries(entry.sections).map(([name, body]) => (body === null ? `-${name}` : name));
			const parts: string[] = [];
			if (names.length > 0) parts.push(`分段 ${names.join("、")}`);
			if ((entry.toolsAdded ?? []).length > 0) {
				parts.push(`工具 +${(entry.toolsAdded ?? []).map((tool) => tool.name).join("、")}`);
			}
			if ((entry.toolsRemoved ?? []).length > 0) parts.push(`工具 -${(entry.toolsRemoved ?? []).join("、")}`);
			return parts.join("；");
		}
		case "model_change":
			return `模型 → ${entry.provider}/${entry.model}`;
		case "effort_change":
			return `思考等级 → ${entry.effort}`;
		case "usage":
			return `${entry.kind === "compact" ? "压缩用量" : "用量"} ${entry.model}：${entry.usage.total} token`;
		case "compaction":
			return `压缩 ${entry.covered.length} 条消息（约 ${entry.tokensBefore} token）：${clip(entry.summary)}`;
	}
}

function clip(text: string): string {
	const line = text.replaceAll(/\s+/g, " ").trim();
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
