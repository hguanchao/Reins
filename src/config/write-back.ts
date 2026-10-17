import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ConfigError } from "./config-error.ts";
import { configFilePath } from "./paths.ts";
import { TomlDocument } from "./toml/index.ts";
import type { ConfigValue } from "./value.ts";

/**
 * 用户级配置的定点回写。
 *
 * 有两处配置由程序自己写：工作区的信任清单与通知方式。它们都得写在**用户级**配置里，因为
 * 这两项决定的正是「一个目录能不能影响程序行为」——放在项目配置里，等于让不受信任的目录
 * 自己把门打开。
 *
 * 回写走保留原文的 TOML 文档：使用者写下的注释与排版是他自己的东西，程序改一个键没有理由
 * 把它们冲掉。
 */

/**
 * 改用户级配置里的一个键。
 *
 * update 拿到当前值（没有就是 undefined），返回要写进去的值。先算好再落盘：算出错时文件
 * 保持原样，不会留下改到一半的配置。
 */
export function updateUserConfigValue(
	path: readonly string[],
	update: (current: ConfigValue | undefined) => ConfigValue,
	file: string = configFilePath(),
): void {
	let document: TomlDocument;
	try {
		document = new TomlDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
	} catch (error) {
		throw new ConfigError(`Cannot read config: ${describeError(error)}`, { file });
	}
	const next = update(document.get(path));

	try {
		mkdirSync(dirname(file), { recursive: true });
		document.set([...path], next);
		writeFileSync(file, document.source, "utf8");
	} catch (error) {
		throw new ConfigError(`Cannot write config: ${describeError(error)}`, { file });
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
