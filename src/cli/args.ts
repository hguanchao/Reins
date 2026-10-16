/** 命令行用法错误。与配置错误区分开：这不是配置写错了，而是命令形式不对。 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type CliCommand = "print" | "chat" | "config-check" | "sessions" | "help" | "version";

/** sessions 子命令。 */
export type SessionsAction = "list" | "show";

export interface CliOptions {
	readonly command: CliCommand;
	/** sessions 子命令要做的事；其余命令为 undefined */
	readonly sessionsAction: SessionsAction | undefined;
	/** sessions 子命令指向的会话标识；list 不需要 */
	readonly sessionRef: string | undefined;
	/** 交给模型的句子；仅 print 模式使用 */
	readonly prompt: string;
	readonly configPath: string | undefined;
	readonly modelsPath: string | undefined;
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
	let modelsPath: string | undefined;
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
			if (value === undefined || value.startsWith("-")) throw new UsageError(`${argument} 需要一个标识`);
			if (argument === "--resume") resume = value;
			else forkAt = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--resume=") || argument.startsWith("--at=")) {
			const separator = argument.indexOf("=");
			const value = argument.slice(separator + 1);
			if (value.length === 0) throw new UsageError(`${argument.slice(0, separator)} 需要一个标识`);
			if (argument.startsWith("--resume=")) resume = value;
			else forkAt = value;
			continue;
		}
		if (argument === "--config" || argument === "--models") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) throw new UsageError(`${argument} 需要一个路径`);
			if (argument === "--config") configPath = value;
			else modelsPath = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--config=") || argument.startsWith("--models=")) {
			const separator = argument.indexOf("=");
			const value = argument.slice(separator + 1);
			if (value.length === 0) throw new UsageError(`${argument.slice(0, separator)} 需要一个路径`);
			if (argument.startsWith("--config=")) configPath = value;
			else modelsPath = value;
			continue;
		}
		if (argument === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (argument.startsWith("-")) throw new UsageError(`无法识别的选项 ${argument}`);

		positionals.push(argument);
	}

	const command = resolveCommand(positionals, explicitPrint);
	if (command === "sessions") return sessionsOptions(positionals);

	// 分叉与接续的组合必须说清楚：这些开关单独出现时含义不完整
	if (fork && resume === undefined) throw new UsageError("--fork 要配 --resume：它要指明从哪个会话分叉");
	if (forkAt !== undefined && !fork) throw new UsageError("--at 只和 --fork 一起用");
	if (continueSession && resume !== undefined) throw new UsageError("--continue 与 --resume 只能用其中一个");

	return {
		command,
		sessionsAction: undefined,
		sessionRef: undefined,
		prompt: command === "print" ? positionals.join(" ") : "",
		configPath,
		modelsPath,
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
			modelsPath: undefined,
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
		if (action !== "list" && action !== "show") {
			throw new UsageError("sessions 支持 list 与 show 两个子命令");
		}
		const ref = args[2];
		if (action !== "list" && ref === undefined) throw new UsageError(`sessions ${action} 需要一个会话标识`);
		const allowed = action === "list" ? 2 : 3;
		if (args.length > allowed) {
			throw new UsageError(`sessions ${action} 不接受额外参数：${args.slice(allowed).join(" ")}`);
		}
		return { ...special("sessions"), sessionsAction: action, sessionRef: ref };
	}
}

function resolveCommand(positionals: readonly string[], explicitPrint: boolean): CliCommand {
	if (positionals[0] === "config") {
		if (positionals[1] !== "check") throw new UsageError("config 目前只支持 check 子命令");
		if (positionals.length > 2) throw new UsageError(`config check 不接受额外参数：${positionals.slice(2).join(" ")}`);
		return "config-check";
	}
	if (positionals[0] === "sessions") return "sessions";
	// 没有句子、也没有要求非交互，就是进交互界面
	if (!explicitPrint && positionals.length === 0) return "chat";
	if (positionals.length === 0) throw new UsageError("-p 后面需要给出要执行的句子");
	return "print";
}

export const HELP_TEXT = `Reins —— 终端编码智能体

用法:
  reins                     进入交互界面
  reins <句子>              执行一句话，结果写到标准输出
  reins -p <句子>           同上，显式指定非交互模式
  reins sessions list       列出当前目录下的会话
  reins sessions show <标识> 显示一个会话的条目与用量
  reins config check        校验配置文件并列出解析结果
  reins --help              显示本帮助
  reins --version           显示版本

会话:
  -c, --continue             接着当前目录下最近一次会话继续
  --resume <标识>            接续指定的会话；标识用 sessions list 查
  --fork                     把 --resume 那个会话的历史复制进一个新会话，原会话保持原样
  --at <条目标识>            分叉的起点，省略时从会话当前的位置分叉

选项:
  --yes                      非交互模式下，凡是要征求同意的调用一律视为同意；拒绝规则与审查模型照旧生效
  --trust                    读取当前工作区自带的配置，并把这一决定记下来
  --no-trust                 不读取当前工作区自带的配置，并把这一决定记下来
  --config <路径>            指定 config.toml，默认取配置目录下的同名文件
  --models <路径>            指定 models.json，默认取配置目录下的同名文件

配置目录由环境变量 REINS_HOME 覆盖，默认为用户主目录下的 .reins。
`;
