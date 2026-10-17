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

/** 命令清单，用于帮助文本。 */
export const BUILTIN_COMMANDS: readonly { readonly name: string; readonly description: string }[] = [
	{ name: "help", description: "显示这份帮助" },
	{ name: "exit", description: "退出（空输入时按 Ctrl+D 也一样）" },
	{ name: "notify", description: `查看或设置完成提醒：${NOTIFY_MODES.join(" / ")}` },
	{ name: "trust", description: "查看或修改当前工作区的信任状态" },
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
	const lines: Line[] = [styled("界面命令", BOLD)];
	for (const command of BUILTIN_COMMANDS) {
		lines.push(concat(styled(`  /${command.name}`, ACCENT), plain(`  ${command.description}`)));
	}

	const pluginCommands = context.runtime.commands;
	if (pluginCommands.length > 0) {
		lines.push([], styled("插件命令", BOLD));
		for (const command of pluginCommands) {
			lines.push(concat(styled(`  /${command.name}`, ACCENT), plain(`  ${command.description}`)));
		}
	}

	lines.push(
		[],
		styled("按键", BOLD),
		plain("  Enter 发送　Ctrl+C 中止或退出　Ctrl+D 退出　↑ ↓ 输入历史　Ctrl+L 重画"),
		plain("  PageUp/PageDown 翻页　Ctrl+P/Ctrl+N 逐行　滚轮翻历史"),
		plain("  翻阅时 Home/End 跳到最早/回到末尾；鼠标选中文本要按住 Shift"),
	);
	return lines;
}

function notifyCommand(args: string, context: BuiltinContext): BuiltinResult {
	const argument = args.trim();
	if (argument.length === 0) {
		return {
			lines: [
				concat(plain("完成提醒："), styled(context.notify(), ACCENT)),
				styled(`  可用取值：${NOTIFY_MODES.join(" / ")}`, DIM),
			],
		};
	}

	const mode = NOTIFY_MODES.find((item) => item === argument);
	if (mode === undefined) {
		// 写错取值就明确拒绝，不要「看起来设置了其实没变」
		return { lines: [styled(`无法识别的取值 ${argument}；可用取值：${NOTIFY_MODES.join(" / ")}`, BAD)] };
	}

	context.setNotify(mode);
	return { lines: [concat(plain("完成提醒已设为 "), styled(mode, ACCENT), plain("，并写回配置。"))] };
}

function trustCommand(args: string, context: BuiltinContext): BuiltinResult {
	const trust = context.runtime.trust;
	const argument = args.trim().toLowerCase();
	const status = trustStatusLines(context);

	if (argument === "") return { lines: status };

	if (argument !== "yes" && argument !== "no") {
		return { lines: [...status, styled("用法：/trust yes 或 /trust no", DIM)] };
	}

	const wanted = argument === "yes";
	context.runtime.setTrusted(wanted);
	return {
		lines: [
			...status,
			concat(
				plain(`已把 ${trust.root} 记为`),
				styled(wanted ? "信任" : "不信任", ACCENT),
				plain("；本次运行已经按先前的结果装配完毕，下次启动生效。"),
			),
		],
	};
}

function trustStatusLines(context: BuiltinContext): readonly Line[] {
	const trust = context.runtime.trust;
	if (trust.files.length === 0) {
		return [plain(`${trust.root} 里没有需要信任才能读取的配置。`)];
	}
	if (trust.trusted) {
		return [
			concat(plain("已信任 "), styled(trust.root, ACCENT), plain("，自带的配置参与了本次运行：")),
			...trust.files.map((file) => styled(`  ${file}`, DIM)),
		];
	}
	return [
		concat(plain("未信任 "), styled(trust.root, WARN), plain("，下列配置没有读取：")),
		...trust.files.map((file) => styled(`  ${file}`, DIM)),
		styled("用 /trust yes 打开它的配置；合并只会更严，不会放宽审批与沙箱。", DIM),
	];
}

/** 插件命令是否与自带命令重名。自带命令优先，重名的插件命令不会被调用。 */
export function isBuiltinCommand(name: string): boolean {
	return BUILTIN_COMMANDS.some((command) => command.name === name);
}
