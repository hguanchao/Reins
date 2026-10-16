/** 命令行用法错误。与配置错误区分开：这类问题不是使用者写错了配置，而是命令形式不对。 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type CliCommand = "config-check" | "help" | "version";

export interface CliOptions {
	readonly command: CliCommand;
	/** 覆盖 config.toml 的位置；未指定时用配置目录下的默认位置 */
	readonly configPath: string | undefined;
	/** 覆盖 models.json 的位置 */
	readonly modelsPath: string | undefined;
}

/**
 * 解析命令行参数。
 *
 * 只接受当前确实存在的选项：把无法识别的选项直接报错，比默默忽略更容易发现问题。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
	let command: CliCommand | undefined;
	let configPath: string | undefined;
	let modelsPath: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === "--help" || argument === "-h") {
			return { command: "help", configPath: undefined, modelsPath: undefined };
		}
		if (argument === "--version" || argument === "-v") {
			return { command: "version", configPath: undefined, modelsPath: undefined };
		}
		if (argument === "--config" || argument === "--models") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				throw new UsageError(`${argument} 需要一个路径`);
			}
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
		if (argument.startsWith("-")) {
			throw new UsageError(`无法识别的选项 ${argument}`);
		}

		if (argument === "config") {
			const sub = argv[index + 1];
			if (sub !== "check") {
				throw new UsageError("config 目前只支持 check 子命令");
			}
			command = "config-check";
			index += 1;
			continue;
		}

		throw new UsageError(`无法识别的参数 ${argument}`);
	}

	return { command: command ?? "help", configPath, modelsPath };
}

export const HELP_TEXT = `Reins —— 终端编码智能体

用法:
  reins                     进入交互界面
  reins config check        校验配置文件并列出解析结果
  reins --help              显示本帮助
  reins --version           显示版本

选项:
  --config <路径>            指定 config.toml，默认取配置目录下的同名文件
  --models <路径>            指定 models.json，默认取配置目录下的同名文件

配置目录由环境变量 REINS_HOME 覆盖，默认为用户主目录下的 .reins。
`;
