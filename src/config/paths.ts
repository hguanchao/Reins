import { homedir } from "node:os";
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
