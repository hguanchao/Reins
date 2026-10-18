/** 命令行用法错误。与配置错误区分开：这不是配置写错了，而是命令形式不对。 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** CLI 只做纯文本聊天：一次提问，答案写到标准输出。 */
export type CliCommand = "print" | "help" | "version";

export interface CliOptions {
	readonly command: CliCommand;
	/** 交给模型的句子；仅 print 模式使用 */
	readonly prompt: string;
	readonly configPath: string | undefined;
	readonly providersPath: string | undefined;
	/**
	 * 把「需要征求同意」的调用一律视为同意。
	 *
	 * 它只解决「没有人可以问」这一种情形：拒绝规则与审查模型都照旧生效。
	 */
	readonly assumeYes: boolean;
	/** 对当前工作区信任与否给出的明确结论；没给就是 undefined */
	readonly trust: boolean | undefined;
}

/**
 * 解析命令行参数。
 *
 * 只接受当前确实存在的选项：无法识别的选项直接报错，比默默忽略更容易发现问题。位置参数
 * 拼成要执行的句子，因此 `reins 看看这个项目` 与 `reins -p 看看这个项目` 等价。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
	const positionals: string[] = [];
	let configPath: string | undefined;
	let providersPath: string | undefined;
	let explicitPrint = false;
	let assumeYes = false;
	let trust: boolean | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === "--help" || argument === "-h") return optionsOf("help");
		if (argument === "--version" || argument === "-v") return optionsOf("version");

		if (argument === "--print" || argument === "-p") {
			explicitPrint = true;
			continue;
		}
		if (argument === "--yes" || argument === "-y") {
			assumeYes = true;
			continue;
		}
		if (argument === "--trust") {
			trust = true;
			continue;
		}
		if (argument === "--no-trust") {
			trust = false;
			continue;
		}
		if (argument === "--config" || argument === "--providers") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) throw new UsageError(`${argument} requires a path`);
			if (argument === "--config") configPath = value;
			else providersPath = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--config=") || argument.startsWith("--providers=")) {
			const separator = argument.indexOf("=");
			const value = argument.slice(separator + 1);
			if (value.length === 0) throw new UsageError(`${argument.slice(0, separator)} requires a path`);
			if (argument.startsWith("--config=")) configPath = value;
			else providersPath = value;
			continue;
		}
		if (argument === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (argument.startsWith("-")) throw new UsageError(`unknown option ${argument}`);

		positionals.push(argument);
	}

	const command = resolveCommand(positionals, explicitPrint);
	return {
		command,
		prompt: command === "print" ? positionals.join(" ") : "",
		configPath,
		providersPath,
		assumeYes,
		trust,
	};
}

function optionsOf(command: CliCommand): CliOptions {
	return {
		command,
		prompt: "",
		configPath: undefined,
		providersPath: undefined,
		assumeYes: false,
		trust: undefined,
	};
}

function resolveCommand(positionals: readonly string[], explicitPrint: boolean): CliCommand {
	// 没有句子也没要求非交互：没有交互界面可进，就展示用法
	if (!explicitPrint && positionals.length === 0) return "help";
	if (positionals.length === 0) throw new UsageError("-p requires a prompt");
	return "print";
}

export const HELP_TEXT = `Reins — terminal coding agent

Usage:
  reins <prompt>              Run one prompt, write the answer to stdout
  reins -p <prompt>           Same, explicitly non-interactive
  reins --help                Show this help
  reins --version             Show the version

Options:
  --yes                       Every approval request counts as granted; deny rules and the review model still apply
  --trust                     Read the config shipped in this workspace and record the decision
  --no-trust                  Do not read the workspace config, and record the decision
  --config <path>             Use the given config.toml instead of the one in the config directory
  --providers <path>          Use the given providers.json instead of the one in the config directory

The config directory is set by REINS_HOME, defaulting to .reins under the home directory
`;
