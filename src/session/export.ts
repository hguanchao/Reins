import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
	assistantText,
	assistantToolCalls,
	userImages,
	userText,
	type LlmMessage,
} from "#src/llm/messages.ts";
import { SUMMARY_PREFIX } from "#src/session/fold.ts";
import type { Session } from "#src/session/session.ts";
import { describeUsage, sumUsage } from "#src/session/usage.ts";

/**
 * 会话导出。
 *
 * Markdown 取当前分支的消息，给人看；JSONL 直接复制会话文件，保留全部分支与原始条目，给程序
 * 或另一次导入用。两者都只读会话，不改变它。
 */

export type SessionExportFormat = "markdown" | "jsonl";

export interface SessionExportResult {
	readonly path: string;
	readonly bytes: number;
	readonly format: SessionExportFormat;
	/** 目标文件原本不存在 */
	readonly created: boolean;
}

/** 导出里单个工具结果的字符上限：再长就不是给人读的，完整内容仍在会话文件里。 */
const MAX_TOOL_RESULT_CHARS = 8_000;

/** 把当前分支渲染成一份 Markdown 记录。 */
export function renderSessionMarkdown(session: Session): string {
	const lines: string[] = [
		`# Reins session ${session.id}`,
		"",
		`- Working directory: \`${session.cwd}\``,
		`- Exported: ${new Date().toISOString()}`,
	];
	const usage = describeUsage(sumUsage(session.entries()));
	if (usage.length > 0) lines.push(`- Usage: ${usage}`);
	lines.push("");

	const messages = session.state().messages;
	if (messages.length === 0) lines.push("_No messages yet._");

	for (const message of messages) {
		lines.push(...renderMessage(message));
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 写入导出文件。
 *
 * 后缀为 `.jsonl` 时复制会话文件；其余按 Markdown 处理。父目录不存在时一并建出来。
 */
export function writeSessionExport(session: Session, target: string): SessionExportResult {
	const format: SessionExportFormat = target.toLowerCase().endsWith(".jsonl") ? "jsonl" : "markdown";
	const created = !existsSync(target);
	mkdirSync(dirname(target), { recursive: true });

	if (format === "jsonl") {
		if (session.path === null) {
			throw new Error("This session is not saved to a file, so JSONL export is unavailable");
		}
		// 复制到自身会先截断源文件；宁可拒绝，也不能把会话历史弄丢
		if (resolve(target) === resolve(session.path)) {
			throw new Error("The export target is the session file itself; choose another path");
		}
		copyFileSync(session.path, target);
		return { path: target, bytes: statSync(target).size, format, created };
	}

	const text = renderSessionMarkdown(session);
	writeFileSync(target, text, "utf8");
	return { path: target, bytes: Buffer.byteLength(text, "utf8"), format, created };
}

function renderMessage(message: LlmMessage): readonly string[] {
	switch (message.role) {
		case "user": {
			const text = userText(message).trim();
			const images = userImages(message);
			if (text.startsWith(SUMMARY_PREFIX)) {
				const summary = text.slice(SUMMARY_PREFIX.length).trim();
				return ["## Summary", "", summary.length > 0 ? summary : "(empty summary)", ""];
			}
			const lines = ["## User", "", text.length > 0 ? text : images.length > 0 ? "" : "(empty)"];
			for (const image of images) lines.push("", `[image: ${image.name ?? "image"}]`);
			lines.push("");
			return lines;
		}
		case "assistant": {
			const lines: string[] = [];
			const text = assistantText(message).trim();
			if (text.length > 0) lines.push("## Assistant", "", text, "");
			for (const call of assistantToolCalls(message)) {
				const plan = call.name === "present_plan" ? call.arguments["plan"] : undefined;
				if (typeof plan === "string" && plan.trim().length > 0) {
					lines.push("## Plan", "", plan.trim(), "");
					continue;
				}
				lines.push(
					`### Tool call: ${call.name}`,
					"",
					"```json",
					JSON.stringify(call.arguments, null, 2) ?? "{}",
					"```",
					"",
				);
			}
			return lines;
		}
		case "toolResult": {
			const truncated =
				message.content.length > MAX_TOOL_RESULT_CHARS
					? `${message.content.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated for export)`
					: message.content;
			return [
				`### Tool result: ${message.toolName}${message.isError ? " (error)" : ""}`,
				"",
				"```",
				truncated,
				"```",
				"",
			];
		}
	}
}
