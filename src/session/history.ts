import type { SessionEntry, SessionHistoryItem } from "./port.ts";

/**
 * 把会话条目整理成界面能直接铺开的历史。
 *
 * 条目是模型视角的记录：助手消息里的文本、思考与工具调用混在一个数组里，工具结果又是另一条
 * 消息。界面不该重复这套配对逻辑，所以在这里一次拆开、按显示顺序排好。
 *
 * 只取消息类条目；提示词、模型变更与用量属于会话状态，不构成对话内容。压缩检查点保留一行
 * 说明，让使用者知道前面那段被摘要过。
 */

interface PendingTool {
	readonly name: string;
	readonly args: Readonly<Record<string, unknown>>;
}

export function historyFromEntries(entries: readonly SessionEntry[]): readonly SessionHistoryItem[] {
	const items: SessionHistoryItem[] = [];
	const pending = new Map<string, PendingTool>();

	for (const entry of entries) {
		const at = timeOf(entry.timestamp);
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") {
					items.push({ kind: "user", text: message.content, at });
					continue;
				}
				if (message.role === "assistant") {
					const texts: string[] = [];
					const flushText = (): void => {
						if (texts.length === 0) return;
						items.push({ kind: "assistant", text: texts.join("\n\n"), at });
						texts.length = 0;
					};
					for (const block of message.content) {
						if (block.type === "thinking") {
							// 历史里没有保留耗时；0 表示「只知道发生过」
							flushText();
							items.push({ kind: "thinking", text: block.text, at, elapsedMs: 0 });
							continue;
						}
						if (block.type === "text") {
							texts.push(block.text);
							continue;
						}
						flushText();
						pending.set(block.id, { name: block.name, args: block.arguments });
					}
					flushText();
					continue;
				}
				const tool = pending.get(message.toolCallId);
				items.push({
					kind: "tool",
					name: message.toolName,
					args: tool?.args ?? {},
					output: message.content,
					isError: message.isError,
					at,
				});
				pending.delete(message.toolCallId);
				continue;
			}
			case "compaction":
				items.push({
					kind: "system",
					text: `Context compacted (${entry.tokensBefore} tokens before)`,
					at,
				});
				continue;
			default:
				// 提示词、模型/思考等级变更与用量都不是对话内容
				continue;
		}
	}

	return items;
}

function timeOf(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Date.now();
}
