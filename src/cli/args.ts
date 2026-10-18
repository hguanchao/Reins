/** 命令行用法错误。与配置错误区分开：这不是配置写错了，而是命令形式不对。 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type CliCommand = "print" | "config-check" | "sessions" | "help" | "version";

/** sessions 子命令。 */
export type SessionsAction = "list" | "show" | "export";

export interface CliOptions {
	readonly command: CliCommand;
	/** sessions 子命令要做的事；其余命令为 undefined */
	readonly sessionsAction: SessionsAction | undefined;
	/** sessions 子命令指向的会话标识；list 不需要 */
	readonly sessionRef: string | undefined;
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
	/** 接着当前目录下最近一次会话继续 */
	readonly continueSession: boolean;
	/** 要接续的会话标识 */
	readonly resume: string | undefined;
	/** 把既有会话的历史复制进一个新会话，原会话不动 */
	readonly fork: boolean;
	/** 分叉的起点条目；省略时从会话当前的位置分叉 */
	readonly forkAt: string | undefined;
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
	let continueSession = false;
	let resume: string | undefined;
	let fork = false;
	let forkAt: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === "--help" || argument === "-h") return special("help");
		if (argument === "--version" || argument === "-v") return special("version");

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
		if (argument === "--continue" || argument === "-c") {
			continueSession = true;
			continue;
		}
		if (argument === "--fork") {
			fork = true;
			continue;
		}
		if (argument === "--resume" || argument === "--at") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) throw new UsageError(`${argument} requires an id`);
			if (argument === "--resume") resume = value;
			else forkAt = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--resume=") || argument.startsWith("--at=")) {
			const separator = argument.indexOf("=");
			const value = argument.slice(separator + 1);
			if (value.length === 0) throw new UsageError(`${argument.slice(0, separator)} requires an id`);
			if (argument.startsWith("--resume=")) resume = value;
			else forkAt = value;
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
	if (command === "sessions") return sessionsOptions(positionals);

	// 分叉与接续的组合必须说清楚：这些开关单独出现时含义不完整
	if (fork && resume === undefined) throw new UsageError("--fork requires --resume to name the session to fork from");
	if (forkAt !== undefined && !fork) throw new UsageError("--at only works together with --fork");
	if (continueSession && resume !== undefined) throw new UsageError("use either --continue or --resume, not both");

	return {
		command,
		sessionsAction: undefined,
		sessionRef: undefined,
		prompt: command === "print" ? positionals.join(" ") : "",
		configPath,
		providersPath,
		assumeYes,
		trust,
		continueSession,
		resume,
		fork,
		forkAt,
	};

	function special(which: CliCommand): CliOptions {
		return {
			command: which,
			sessionsAction: undefined,
			sessionRef: undefined,
			prompt: "",
			configPath: undefined,
			providersPath: undefined,
			assumeYes: false,
			trust: undefined,
			continueSession: false,
			resume: undefined,
			fork: false,
			forkAt: undefined,
		};
	}

	function sessionsOptions(args: readonly string[]): CliOptions {
		const action = args[1];
		if (action !== "list" && action !== "show" && action !== "export") {
			throw new UsageError("sessions has three subcommands: list, show, export");
		}
		const ref = args[2];
		if (action !== "list" && ref === undefined) throw new UsageError(`sessions ${action} requires a session id`);
		const allowed = action === "list" ? 2 : 3;
		if (args.length > allowed) {
			throw new UsageError(`sessions ${action} takes no extra arguments: ${args.slice(allowed).join(" ")}`);
		}
		return { ...special("sessions"), sessionsAction: action, sessionRef: ref };
	}
}

function resolveCommand(positionals: readonly string[], explicitPrint: boolean): CliCommand {
	if (positionals[0] === "config") {
		if (positionals[1] !== "check") throw new UsageError("config only supports the check subcommand");
		if (positionals.length > 2) throw new UsageError(`config check takes no extra arguments: ${positionals.slice(2).join(" ")}`);
		return "config-check";
	}
	if (positionals[0] === "sessions") return "sessions";
	// 没有句子也没要求非交互：没有交互界面可进，就展示用法
	if (!explicitPrint && positionals.length === 0) return "help";
	if (positionals.length === 0) throw new UsageError("-p requires a prompt");
	return "print";
}

export const HELP_TEXT = `Reins — terminal coding agent

Usage:
  reins <prompt>              Run one prompt, write the answer to stdout
  reins -p <prompt>           Same, explicitly non-interactive
  reins sessions list         List sessions under the current directory
  reins sessions show <id>    Show one session's entries and usage
  reins sessions export <id>  Export as Markdown to stdout (redirect to a file)
  reins config check          Validate the config files and print the result
  reins --help                Show this help
  reins --version             Show the version

Sessions:
  -c, --continue              Continue the most recent session in this directory
  --resume <id>               Resume the given session; list ids with sessions list
  --fork                      Copy the --resume session into a new one, leaving the original as is
  --at <entry id>             Fork point; defaults to the session's current position

Options:
  --yes                       Every approval request counts as granted; deny rules and the review model still apply
  --trust                     Read the config shipped in this workspace and record the decision
  --no-trust                  Do not read the workspace config, and record the decision
  --config <path>             Use the given config.toml instead of the one in the config directory
  --providers <path>          Use the given providers.json instead of the one in the config directory

The config directory is set by REINS_HOME, defaulting to .reins under the home directory
`;
