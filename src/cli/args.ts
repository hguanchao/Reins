/** 命令行用法错误。与配置错误区分开：这不是配置写错了，而是命令形式不对。 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** CLI 的运行方式：启动界面、一次提问、帮助、版本，或管理插件。 */
type CliCommand = "tui" | "print" | "help" | "version" | "plugin";

export interface CliOptions {
	readonly command: CliCommand;
	/** 交给模型的句子；仅 print 模式使用 */
	readonly prompt: string;
	readonly configPath: string | undefined;
	readonly providersPath: string | undefined;
	/** 对当前工作区信任与否给出的明确结论；没给就是 undefined */
	readonly trust: boolean | undefined;
	/** 全屏界面要接续的会话标识；没给就是新建会话 */
	readonly resume: string | undefined;
	/** print 模式把事件流写成 JSONL，而不是把回答写到标准输出 */
	readonly json: boolean;
	/** 插件子命令的动作；仅 command 为 plugin 时有值 */
	readonly pluginAction: "add" | "list" | undefined;
	/** add 的来源：npm 包名、git 仓库地址或本地目录 */
	readonly pluginSource: string | undefined;
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
	let trust: boolean | undefined;
	let resume: string | undefined;
	let json = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === "--help" || argument === "-h") return optionsOf("help");
		if (argument === "--version" || argument === "-v") return optionsOf("version");

		// 插件子命令先于其余参数处理：来源本身可能是任意文本，不再当选项或句子解析
		if (argument === "plugin") {
			return parsePluginCommand(argv.slice(index + 1), {
				configPath,
				providersPath,
				trust,
				resume,
				json,
			});
		}

		if (argument === "--print" || argument === "-p") {
			explicitPrint = true;
			continue;
		}
		if (argument === "--json") {
			json = true;
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
		if (argument === "--resume") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) throw new UsageError("--resume requires an id");
			resume = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--resume=")) {
			const value = argument.slice("--resume=".length);
			if (value.length === 0) throw new UsageError("--resume requires an id");
			resume = value;
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
	if (resume !== undefined && command === "print") {
		throw new UsageError("--resume only works with the full-screen interface");
	}
	// 事件流是给程序读的，标准输出里只有 JSON 行；全屏界面下它没有意义，直接报错而不是忽略
	if (json && command !== "print") {
		throw new UsageError("--json only works together with -p");
	}
	return {
		command,
		prompt: command === "print" ? positionals.join(" ") : "",
		configPath,
		providersPath,
		trust,
		resume,
		json,
		pluginAction: undefined,
		pluginSource: undefined,
	};
}

function optionsOf(command: CliCommand): CliOptions {
	return {
		command,
		prompt: "",
		configPath: undefined,
		providersPath: undefined,
		trust: undefined,
		resume: undefined,
		json: false,
		pluginAction: undefined,
		pluginSource: undefined,
	};
}

/** `reins plugin add|list` 子命令；来源是剩余的位置参数。 */
function parsePluginCommand(
	rest: readonly string[],
	shared: Pick<CliOptions, "configPath" | "providersPath" | "trust" | "resume" | "json">,
): CliOptions {
	const action = rest[0];
	if (action !== "add" && action !== "list") {
		throw new UsageError("plugin requires an action: add <source> or list");
	}
	if (action === "list" && rest.length > 1) throw new UsageError("plugin list takes no arguments");

	const source = action === "add" ? rest.slice(1).join(" ") : undefined;
	if (action === "add" && (source === undefined || source.length === 0)) {
		throw new UsageError("plugin add requires a source: an npm package, a git URL, or a local directory");
	}

	return {
		command: "plugin",
		prompt: "",
		...shared,
		pluginAction: action,
		pluginSource: source,
	};
}

function resolveCommand(positionals: readonly string[], explicitPrint: boolean): CliCommand {
	// 没有句子也没要求非交互：进入全屏界面
	if (!explicitPrint && positionals.length === 0) return "tui";
	if (positionals.length === 0) throw new UsageError("-p requires a prompt");
	return "print";
}

export const HELP_TEXT = `Reins — terminal coding agent

Usage:
  reins                       Start the full-screen interface
  reins <prompt>              Run one prompt, write the answer to stdout
  reins -p <prompt>           Same, explicitly non-interactive
  reins -p --json <prompt>    Write a JSONL event stream to stdout instead
  reins plugin add <source>   Install a plugin (npm package, git URL, or local directory)
  reins plugin list           Show installed plugins and what each one provides
  reins --help                Show this help
  reins --version             Show the version

Options:
  --json                      Emit one JSON event per line; requires -p
  --trust                     Read the config shipped in this workspace and record the decision
  --no-trust                  Do not read the workspace config, and record the decision
  --config <path>             Use the given config.toml instead of the one in the config directory
  --providers <path>          Use the given providers.json instead of the one in the config directory
  --resume <id>               Resume the given session in the full-screen interface

The config directory is set by REINS_HOME, defaulting to .reins under the home directory
`;
