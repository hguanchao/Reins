import type { CommandMenuItem } from "#src/tui/panel/command-menu.ts";
import type { TuiOptions } from "#src/tui/options.ts";
import { commandDescription } from "#src/tui/copy.ts";

/**
 * 一轮进行中也能执行的命令。
 *
 * 它们只影响界面（帮助页、技能与 MCP 清单、选择面板）或下一轮，不碰正在跑的那一轮：
 * 模型与思考等级在 startRun 时就已交给客户端，改的是下一轮。/compact 会另起一轮，
 * 插件命令由插件自己决定，都等这一轮结束。
 */
export const TURN_SAFE_COMMANDS: ReadonlySet<string> = new Set([
	"help",
	"model",
	"effort",
	"skills",
	"mcps",
]);

/**
 * 命令补全列表：配置不可用时仍然显示，但标成不可执行；隐藏项只在完整输入时执行。
 *
 * 说明文字统一由文案模块给出：能用的说清做什么，不能用的说清缺什么。
 */
export function createBuiltinCommands(options: TuiOptions): readonly CommandMenuItem[] {
	const entries: readonly { readonly name: string; readonly enabled: boolean; readonly hidden?: boolean }[] = [
		{ name: "model", enabled: options.modelMenu !== undefined },
		{ name: "effort", enabled: options.effortMenu !== undefined },
		{ name: "compact", enabled: options.agent?.compact !== undefined },
		{ name: "plan", enabled: options.planMode !== undefined },
		{ name: "session", enabled: options.sessionMenu !== undefined },
		{ name: "export", enabled: options.exportSession !== undefined, hidden: options.exportSession === undefined },
		{ name: "review", enabled: options.review !== undefined, hidden: options.review === undefined },
		{ name: "help", enabled: true },
		{ name: "undo", enabled: options.checkpoints?.available() === true },
		{ name: "skills", enabled: options.skills !== undefined },
		{ name: "mcps", enabled: options.mcpServers !== undefined },
	];
	return entries.map((entry) => ({
		name: entry.name,
		description: commandDescription(entry.name, entry.enabled),
		enabled: entry.enabled,
		...(entry.hidden === true ? { hidden: true } : {}),
	}));
}

/** 内置命令 + 当前插件命令；同名时内置优先，插件不能顶掉 /model 这类入口。 */
export function mergeCommands(
	builtin: readonly CommandMenuItem[],
	plugin: readonly CommandMenuItem[],
): readonly CommandMenuItem[] {
	const names = new Set(builtin.map((command) => command.name));
	return [...builtin, ...plugin.filter((command) => !names.has(command.name))];
}

/** 输入开头的命令名；不是斜杠命令时为空串。 */
export function commandNameOf(message: string): string {
	return message.startsWith("/") ? (message.slice(1).split(/\s/, 1)[0] ?? "") : "";
}

/** 按命令名查找；命令名之后的文字是参数。 */
export function findCommand(
	message: string,
	commands: readonly CommandMenuItem[],
): CommandMenuItem | undefined {
	if (!message.startsWith("/")) return undefined;
	return commands.find((item) => item.name === commandNameOf(message));
}

export function commandArgs(message: string, name: string): string {
	return message.slice(name.length + 1).trim();
}
