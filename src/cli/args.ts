/** 命令行用法错误。与配置错误区分开：这不是配置写错了，而是命令形式不对。 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type CliCommand = "print" | "chat" | "config-check" | "help" | "version";

export interface CliOptions {
	readonly command: CliCommand;
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

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === "--help" || argument === "-h") return options("help");
		if (argument === "--version" || argument === "-v") return options("version");

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
	return {
		command,
		prompt: command === "print" ? positionals.join(" ") : "",
		configPath,
		modelsPath,
		assumeYes,
		trust,
	};

	function options(special: CliCommand): CliOptions {
		return {
			command: special,
			prompt: "",
			configPath: undefined,
			modelsPath: undefined,
			assumeYes: false,
			trust: undefined,
		};
	}
}

function resolveCommand(positionals: readonly string[], explicitPrint: boolean): CliCommand {
	if (positionals[0] === "config") {
		if (positionals[1] !== "check") throw new UsageError("config 目前只支持 check 子命令");
		if (positionals.length > 2) throw new UsageError(`config check 不接受额外参数：${positionals.slice(2).join(" ")}`);
		return "config-check";
	}
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
  reins config check        校验配置文件并列出解析结果
  reins --help              显示本帮助
  reins --version           显示版本

选项:
  --yes                      非交互模式下，凡是要征求同意的调用一律视为同意；拒绝规则与审查模型照旧生效
  --trust                    读取当前工作区自带的配置，并把这一决定记下来
  --no-trust                 不读取当前工作区自带的配置，并把这一决定记下来
  --config <路径>            指定 config.toml，默认取配置目录下的同名文件
  --models <路径>            指定 models.json，默认取配置目录下的同名文件

配置目录由环境变量 REINS_HOME 覆盖，默认为用户主目录下的 .reins。
`;
