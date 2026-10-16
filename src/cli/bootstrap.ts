import { readFileSync } from "node:fs";

import { ConfigError } from "../config/config-error.ts";
import { loadConfig } from "../config/config-file.ts";
import { loadModels } from "../config/models-file.ts";
import { configFilePath, modelsFilePath } from "../config/paths.ts";
import { resolveSelection } from "../config/selection.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { formatConfigReport } from "./config-report.ts";

/**
 * 运行时装配的入口。
 *
 * 当前只装配「读出两份配置并校验」这一条链路；随后各阶段会把工作区、插件、模型客户端
 * 依次接进来。参数与命令的分发在这里，具体做什么由各自的函数承担。
 */
export function main(argv: readonly string[]): number {
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			writeStderr(`reins: ${error.message}\n提示：reins --help 查看用法\n`);
			return 2;
		}
		throw error;
	}

	switch (options.command) {
		case "help":
			writeStdout(HELP_TEXT);
			return 0;
		case "version":
			writeStdout(`${readVersion()}\n`);
			return 0;
		case "config-check":
			return runConfigCheck(options);
	}
}

function runConfigCheck(options: CliOptions): number {
	const configFile = options.configPath ?? configFilePath();
	const modelsFile = options.modelsPath ?? modelsFilePath();

	try {
		const config = loadConfig(configFile);
		const models = loadModels(modelsFile);
		const selection = resolveSelection(config, models, configFile, modelsFile);
		writeStdout(
			formatConfigReport({
				configFile,
				modelsFile,
				reinsHome: process.env["REINS_HOME"],
				config,
				models,
				selection,
			}),
		);
		return 0;
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		throw error;
	}
}

/** 版本号取自 package.json；源码即运行产物，因此相对路径在任何安装形态下都成立。 */
function readVersion(): string {
	const url = new URL("../../package.json", import.meta.url);
	const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
	if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
		const version = (parsed as { version: unknown }).version;
		if (typeof version === "string") return version;
	}
	return "未知";
}

function writeStdout(text: string): void {
	process.stdout.write(text);
}

function writeStderr(text: string): void {
	process.stderr.write(text);
}
