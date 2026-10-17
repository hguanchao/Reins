import { formatTimestamp } from "../session/export.ts";
import type { SessionEntry, SessionHeaderEntry, SessionUsageEntry } from "../session/port.ts";
import type { SessionListing } from "../session/store.ts";
import { describeUsage, sumUsage } from "../session/usage.ts";

/**
 * 会话的几个文字报告：清单、详情、条目摘要。
 *
 * 纯文本，因为使用者是隔着终端看的：`sessions list` 用来认出是哪个会话，`sessions show`
 * 用来找到某一条的下标（分叉要从那里开始）。两者都只读，不看上下文里还剩什么——被压缩掉的
 * 历史照样显示，它仍在文件里。
 */

/** 逐条列表里只要时分秒。 */
function clockTime(iso: string): string {
	return formatTimestamp(iso).slice(11);
}

/** 会话清单。 */
export function formatSessionList(listings: readonly SessionListing[]): readonly string[] {
	if (listings.length === 0) return ["No sessions in this directory yet"];

	const lines: string[] = [];
	for (const listing of listings) {
		const title = listing.title === undefined || listing.title.length === 0 ? "(no conversation yet)" : listing.title;
		const fork = listing.forkedFrom === undefined ? "" : `  ↳ forked from ${listing.forkedFrom.session}`;
		lines.push(
			`${formatTimestamp(listing.updatedAt)}  ${listing.id}  ${String(listing.entryCount).padStart(4)} entries  ${title}${fork}`,
		);
	}
	lines.push("", "Run reins sessions show <id> for the entries, reins --resume <id> to continue");
	return lines;
}

/** 会话详情：头信息、父会话链与逐条摘要。 */
export function formatSessionDetail(header: SessionHeaderEntry | undefined, entries: readonly SessionEntry[]): readonly string[] {
	const lines: string[] = [];
	if (header === undefined) {
		lines.push("The session file has no header line, only entries can be listed");
	} else {
		lines.push(`Session ${header.id}`);
		lines.push(`  cwd: ${header.cwd}`);
		lines.push(`  started: ${formatTimestamp(header.timestamp)}`);
		if (header.forkedFrom !== undefined) {
			// 父会话链从这里往上追：那个会话的头里同样记着它的父会话
			lines.push(`  forked from: ${header.forkedFrom.session} entry ${header.forkedFrom.entry}`);
		}
	}
	lines.push(`  entries: ${entries.length}`);

	const leaf = entries[entries.length - 1];
	if (leaf !== undefined) lines.push(`  position: ${leaf.id} (forks and resumes start here)`);

	const usage = sumUsage(entries);
	if (usage.requests > 0) {
		// 被压缩掉的历史同样计在里面：那些 token 确实花掉了
		lines.push(`  usage: ${describeUsage(usage)}`);
	}

	lines.push("", "id        time       type        content");
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
					return `user: ${clip(entry.message.content)}`;
				case "assistant": {
					const text = entry.message.content
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join(" ");
					const calls = entry.message.content.filter((block) => block.type === "toolCall");
					const parts: string[] = [];
					if (text.trim().length > 0) parts.push(clip(text));
					if (calls.length > 0) {
						parts.push(`calls ${calls.map((call) => (call.type === "toolCall" ? call.name : "")).join(", ")}`);
					}
					return `assistant: ${parts.join("; ")}`;
				}
				case "toolResult":
					return `${entry.message.isError ? "tool error" : "tool result"} ${entry.message.toolName}: ${clip(entry.message.content)}`;
			}
		case "system": {
			const names = Object.entries(entry.sections).map(([name, body]) => (body === null ? `-${name}` : name));
			const parts: string[] = [];
			if (names.length > 0) parts.push(`sections ${names.join(", ")}`);
			if ((entry.toolsAdded ?? []).length > 0) {
				parts.push(`tools +${(entry.toolsAdded ?? []).map((tool) => tool.name).join(", ")}`);
			}
			if ((entry.toolsRemoved ?? []).length > 0) parts.push(`tools -${(entry.toolsRemoved ?? []).join(", ")}`);
			return parts.join("; ");
		}
		case "model_change":
			return `model → ${entry.provider}/${entry.model}`;
		case "effort_change":
			return `effort → ${entry.effort}`;
		case "usage":
			return `${usageLabel(entry.kind)} ${entry.model}: ${entry.usage.total} tokens`;
		case "compaction":
			return `compact ${entry.covered.length} messages (~${entry.tokensBefore} tokens): ${clip(entry.summary)}`;
	}
}

/** 用量条目的来源在界面上怎么称呼。 */
function usageLabel(kind: SessionUsageEntry["kind"]): string {
	switch (kind) {
		case "turn":
			return "usage";
		case "compact":
			return "compact usage";
		case "subagent":
			return "subagent usage";
	}
}

function clip(text: string): string {
	const line = text.replaceAll(/\s+/g, " ").trim();
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
