import { actionLines, pageTitle } from "./chrome.ts";
import { characterWidth, displayWidth, sanitizeForDisplay } from "../render/text.ts";
import { THEME } from "../render/theme.ts";
import type { ViewerContent } from "../runtime/types.ts";

/**
 * 长内容整屏查看页。
 *
 * 对话流里的工具输出、命令详情、思考与提示保持原有折叠/预览；这里只负责把同一份原文
 * 按当前宽度重排后完整铺开。页面沿用整屏页的滚动与 Esc 返回，不改变对话流本身。
 */

/** 底部动作条：一条分隔线加一行按键提示。 */
export const VIEWER_ACTION_HEIGHT = 2;

export function viewerPageLines(content: ViewerContent, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const lines: string[] = [pageTitle(`Reins — ${content.title}`, columns), " ".repeat(columns)];

	const text = sanitizeForDisplay(
		content.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "),
	);
	if (text.trim().length === 0) {
		lines.push(subtleLine("(no content)", columns));
		return lines;
	}

	for (const raw of text.split("\n")) {
		if (raw.length === 0) {
			lines.push("");
			continue;
		}
		for (const chunk of wrapPreserving(raw, columns)) {
			const padding = " ".repeat(Math.max(0, columns - displayWidth(chunk)));
			lines.push(`${THEME.textSecondary}${chunk}${THEME.reset}${padding}`);
		}
	}
	return lines;
}

export function viewerActionLines(width: number): readonly string[] {
	return actionLines(width, [
		["Esc", "close", THEME.textSubtle],
		["↑/↓", "scroll", THEME.accent],
		["PgUp/PgDn", "page", THEME.accent],
	]);
}

function subtleLine(text: string, width: number): string {
	const visible = text.slice(0, Math.max(0, width));
	return `${THEME.textSubtle}${visible}${THEME.reset}${" ".repeat(Math.max(0, width - displayWidth(visible)))}`;
}

/** 代码/日志按字符边界折行，保留缩进；与按词折行的说明文字不同。 */
function wrapPreserving(text: string, width: number): readonly string[] {
	const columns = Math.max(1, width);
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const char of text) {
		const charWidth = characterWidth(char);
		if (used + charWidth > columns && line.length > 0) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += char;
		used += charWidth;
	}
	lines.push(line);
	return lines;
}
