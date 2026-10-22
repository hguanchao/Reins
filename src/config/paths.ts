import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 配置目录名，放在用户主目录下。 */
export const CONFIG_DIR_NAME = ".reins";

export const CONFIG_FILE_NAME = "config.toml";
export const PROVIDERS_FILE_NAME = "providers.json";

/** 配置目录，可用环境变量覆盖，便于测试与多套配置并存。 */
export function configDir(): string {
	const override = process.env["REINS_HOME"];
	if (override !== undefined && override.length > 0) return override;
	return join(homedir(), CONFIG_DIR_NAME);
}

export function configFilePath(): string {
	return join(configDir(), CONFIG_FILE_NAME);
}

export function providersFilePath(): string {
	return join(configDir(), PROVIDERS_FILE_NAME);
}

/**
 * 溢出结果的落盘目录。
 *
 * 放在系统临时目录而不是配置目录：这些文件是某一次工具调用留下的中间产物，不属于需要
 * 长期保存的状态，交给系统清理即可。
 */
export function spillDir(): string {
	return join(tmpdir(), "reins-spill");
}

/**
 * 外部插件目录。
 *
 * 放在配置目录下：插件是使用者自己的东西，不属于某个具体项目，换目录工作时也该还在。
 */
export function pluginsDir(): string {
	return join(configDir(), "plugins");
}

/**
 * 技能目录。
 *
 * 与插件同理放在配置目录下：技能是使用者攒下来的工作方式，不该跟着某个项目走。每个技能
 * 占一个子目录，里面放 SKILL.md。
 */
export function skillsDir(): string {
	return join(configDir(), "skills");
}

/**
 * 会话文件所在目录。
 *
 * 按工作根分目录，同一个目录下的会话聚在一起，换目录工作时各自看到自己的历史。
 */
export function sessionsDir(workRoot: string): string {
	return join(configDir(), "sessions", encodeWorkRoot(workRoot));
}

/** 把工作根编码成合法的目录名：去掉分隔符与盘符冒号，保留可读的部分。 */
function encodeWorkRoot(workRoot: string): string {
	const normalized = workRoot.replaceAll(/[/\\:]/g, "-");
	return normalized.startsWith("-") ? normalized.slice(1) : normalized;
}

/**
 * 工作区里的配置目录。
 *
 * 与用户配置目录同名但位置不同：一个是使用者的全局设置，一个是这个项目自带的设置。后者
 * 需要先取得信任才会被读取，因此不能混在同一个位置。
 */
export function projectDirPath(workRoot: string): string {
	return join(workRoot, CONFIG_DIR_NAME);
}

export function projectConfigFilePath(workRoot: string): string {
	return join(projectDirPath(workRoot), CONFIG_FILE_NAME);
}

export function projectProvidersFilePath(workRoot: string): string {
	return join(projectDirPath(workRoot), PROVIDERS_FILE_NAME);
}
