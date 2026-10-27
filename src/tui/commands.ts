import type { CommandMenuItem } from "./panel/command-menu.ts";
import type { TuiOptions } from "./options.ts";

/**
 * 一轮进行中也能执行的命令。
 *
 * 它们只影响界面（帮助页、选择面板）或下一轮，不碰正在跑的那一轮：模型与思考等级在
 * startRun 时就已交给客户端，改的是下一轮。/compact 会另起一轮，插件命令由插件自己决定，
 * 都等这一轮结束。
 */
export const TURN_SAFE_COMMANDS: ReadonlySet<string> = new Set(["help", "model", "effort"]);

/** 命令补全列表：配置不可用时仍然显示，但标成不可执行。 */
export function createBuiltinCommands(options: TuiOptions): readonly CommandMenuItem[] {
	return [
		{
			name: "model",
			description:
				options.modelMenu === undefined
					? "Requires a valid configuration"
					: "Choose the model for this session",
			enabled: options.modelMenu !== undefined,
		},
		{
			name: "effort",
			description:
				options.effortMenu === undefined
					? "Requires a valid configuration"
					: "Choose the reasoning effort for this session",
			enabled: options.effortMenu !== undefined,
		},
		{
			name: "compact",
			description:
				options.agent?.compact === undefined
					? "Requires a valid configuration"
					: "Compress the conversation context into a summary now",
			enabled: options.agent?.compact !== undefined,
		},
		{
			name: "plan",
			description:
				options.planMode === undefined
					? "Plan mode is unavailable in this session"
					: "Plan read-only, then approve before implementing",
			enabled: options.planMode !== undefined,
		},
		{
			name: "session",
			description:
				options.sessionMenu === undefined
					? "Session storage is unavailable"
					: "Switch to another session in this project",
			enabled: options.sessionMenu !== undefined,
		},
		{
			name: "fork",
			description:
				options.sessionMenu?.fork === undefined
					? "Session forking is unavailable"
					: "Fork the current session at its current point",
			enabled: options.sessionMenu?.fork !== undefined,
		},
		{
			name: "help",
			description: "Show the commands and keys",
			enabled: true,
		},
		{
			name: "undo",
			description:
				options.checkpoints?.available() === true
					? "Restore files to before the latest turn"
					: "Checkpoints are unavailable in this workspace",
			enabled: options.checkpoints?.available() === true,
		},
		{
			name: "checkpoints",
			description:
				options.checkpoints?.available() === true
					? "Browse and restore checkpoints"
					: "Checkpoints are unavailable in this workspace",
			enabled: options.checkpoints?.available() === true,
		},
		{
			name: "sandbox",
			description:
				options.sandbox === undefined
					? "Sandbox details are unavailable in this session"
					: "Show sandbox mode and platform limits",
			enabled: options.sandbox !== undefined,
		},
		{
			name: "view-plan",
			description: "Reopen the latest plan",
			enabled: true,
		},
		{
			name: "jobs",
			description:
				options.jobs === undefined
					? "Background jobs are unavailable"
					: "Show background jobs and their output",
			enabled: options.jobs !== undefined,
		},
		{
			name: "skills",
			description:
				options.skills === undefined
					? "Unavailable in this session"
					: "List the skills found on disk",
			enabled: options.skills !== undefined,
		},
		{
			name: "mcps",
			description:
				options.mcpServers === undefined
					? "No MCP connection in this session"
					: "List MCP server connections and their tools",
			enabled: options.mcpServers !== undefined,
		},
	];
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
