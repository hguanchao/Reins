import { NOTIFY_MODES, type NotifyMode } from "../../config/config-file.ts";
import { concat, plain, styled, type Line } from "../../tui/index.ts";
import type { InteractiveRuntime } from "../../tui/frontend.ts";
import { ACCENT, BAD, BOLD, DIM, WARN } from "./theme.ts";

/**
 * 界面自带的那几条命令。
 *
 * 只放「换了别人也得有」的命令：帮助、退出，以及两处配置的查看与修改。其余能力由插件注册，
 * 界面照着清单显示与转发，不认识具体命令做什么。
 *
 * 命令执行期间会话是空闲的，因此这里的每一步都假定没有正在跑的回合。
 */

export interface BuiltinResult {
	readonly lines: readonly Line[];
	/** 使用者要求退出 */
	readonly exit?: boolean;
}

export interface BuiltinContext {
	readonly runtime: InteractiveRuntime;
	/** 当前生效的通知方式（改过之后与配置文件里的取值同步） */
	readonly notify: () => NotifyMode;
	readonly setNotify: (mode: NotifyMode) => void;
}

/** 命令清单，用于帮助文本和斜杠补全。 */
export const BUILTIN_COMMANDS: readonly {
	readonly name: string;
	readonly description: string;
	/** 接受补全后是否补一个空格，方便继续输入参数。 */
	readonly takesArgs?: boolean;
}[] = [
	{ name: "help", description: "Show this help" },
	{ name: "exit", description: "Quit (Ctrl+D on an empty prompt does the same)" },
	{ name: "notify", description: `Show or set completion notifications: ${NOTIFY_MODES.join(" / ")}`, takesArgs: true },
	{ name: "trust", description: "Show or change trust for the current workspace", takesArgs: true },
];

/** 执行一条自带命令；不是自带命令时返回 undefined，由调用方转给插件命令。 */
export function runBuiltin(
	name: string,
	args: string,
	context: BuiltinContext,
): BuiltinResult | undefined {
	switch (name) {
		case "help":
			return { lines: helpLines(context) };
		case "exit":
			return { lines: [], exit: true };
		case "notify":
			return notifyCommand(args, context);
		case "trust":
			return trustCommand(args, context);
		default:
			return undefined;
	}
}

function helpLines(context: BuiltinContext): readonly Line[] {
	const lines: Line[] = [styled("Interface commands", BOLD)];
	for (const command of BUILTIN_COMMANDS) {
		lines.push(concat(styled(`  /${command.name}`, ACCENT), plain(`  ${command.description}`)));
	}

	const pluginCommands = context.runtime.commands;
	if (pluginCommands.length > 0) {
		lines.push([], styled("Plugin commands", BOLD));
		for (const command of pluginCommands) {
			lines.push(concat(styled(`  /${command.name}`, ACCENT), plain(`  ${command.description}`)));
		}
	}

	lines.push(
		[],
		styled("Keys", BOLD),
		plain("  Enter send   Ctrl+J/Alt+Enter newline   Esc/Ctrl+C cancel   Ctrl+D quit"),
		plain("  Type / for the command menu; Up/Down select, Tab completes, Enter runs, Esc closes"),
		plain("  Type @ to reference a file; Tab/Enter insert, Right drills into a folder, Esc closes"),
		plain("  Ctrl+V paste   Ctrl+Shift+V paste inline   Ctrl+Z undo   Ctrl+L redraw"),
		plain("  Multi-line pastes fold into a [Pasted: N lines] chip; double-click or paste again to expand"),
		plain("  Up/Down move in the draft or recall history"),
		plain("  PageUp/PageDown page   Ctrl+P/Ctrl+N line   wheel scrolls the history"),
		plain("  While browsing, Home/End jump to the oldest or newest line; hold Shift to select text"),
		plain("  Drag text to select and copy; drag the bar on the right edge to scroll"),
		plain("  Click a tick or arrow on the rail to jump to that turn"),
		plain("  Click a block to select; double-click to fold; Tab focuses the transcript"),
		plain("  Consecutive read/search/ls calls collapse into a ◈ summary; expand it to list them"),
		plain("  j/k entry   H/L turn   e fold   h/l fold   y copy   Y meta   g/G top/btm   E all"),
		plain("  Ctrl+E folds every thinking block   Tab returns to the prompt"),
	);
	return lines;
}

function notifyCommand(args: string, context: BuiltinContext): BuiltinResult {
	const argument = args.trim();
	if (argument.length === 0) {
		return {
			lines: [
				concat(plain("Completion notifications: "), styled(context.notify(), ACCENT)),
				styled(`  Available: ${NOTIFY_MODES.join(" / ")}`, DIM),
			],
		};
	}

	const mode = NOTIFY_MODES.find((item) => item === argument);
	if (mode === undefined) {
		// 写错取值就明确拒绝，不要「看起来设置了其实没变」
		return { lines: [styled(`Unknown value ${argument}; available: ${NOTIFY_MODES.join(" / ")}`, BAD)] };
	}

	context.setNotify(mode);
	return { lines: [concat(plain("Completion notifications set to "), styled(mode, ACCENT), plain(" and written back to config."))] };
}

function trustCommand(args: string, context: BuiltinContext): BuiltinResult {
	const trust = context.runtime.trust;
	const argument = args.trim().toLowerCase();
	const status = trustStatusLines(context);

	if (argument === "") return { lines: status };

	if (argument !== "yes" && argument !== "no") {
		return { lines: [...status, styled("Usage: /trust yes or /trust no", DIM)] };
	}

	const wanted = argument === "yes";
	context.runtime.setTrusted(wanted);
	return {
		lines: [
			...status,
			concat(
				plain(`${trust.root} is now recorded as `),
				styled(wanted ? "trusted" : "untrusted", ACCENT),
				plain("; this run is already assembled from the earlier result, so it takes effect on the next start."),
			),
		],
	};
}

function trustStatusLines(context: BuiltinContext): readonly Line[] {
	const trust = context.runtime.trust;
	if (trust.files.length === 0) {
		return [plain(`${trust.root} has no config that needs trust to read.`)];
	}
	if (trust.trusted) {
		return [
			concat(styled(trust.root, ACCENT), plain(" is trusted; its config took part in this run:")),
			...trust.files.map((file) => styled(`  ${file}`, DIM)),
		];
	}
	return [
		concat(styled(trust.root, WARN), plain(" is not trusted; these config files were not read:")),
		...trust.files.map((file) => styled(`  ${file}`, DIM)),
		styled("Open it with /trust yes; merging can only tighten approval and sandbox, never relax them.", DIM),
	];
}

/** 插件命令是否与自带命令重名。自带命令优先，重名的插件命令不会被调用。 */
export function isBuiltinCommand(name: string): boolean {
	return BUILTIN_COMMANDS.some((command) => command.name === name);
}
