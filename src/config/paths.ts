import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 配置目录名，放在用户主目录下。 */
export const CONFIG_DIR_NAME = ".reins";

export const CONFIG_FILE_NAME = "config.toml";
export const MODELS_FILE_NAME = "models.json";

/** 配置目录，可用环境变量覆盖，便于测试与多套配置并存。 */
export function configDir(): string {
	const override = process.env["REINS_HOME"];
	if (override !== undefined && override.length > 0) return override;
	return join(homedir(), CONFIG_DIR_NAME);
}

export function configFilePath(): string {
	return join(configDir(), CONFIG_FILE_NAME);
}

export function modelsFilePath(): string {
	return join(configDir(), MODELS_FILE_NAME);
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
