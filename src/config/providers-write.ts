import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { providersFilePath } from "#src/config/paths.ts";
import type { ModelEntry, ProvidersConfig } from "#src/config/providers-file.ts";

/**
 * providers.json 的原子写回。
 *
 * 文件里有 API Key：先写临时文件再改名，尽量把权限收到仅本人可读。Windows 不支持 POSIX
 * 权限位时忽略 chmod，写盘本身仍然成功。
 */
export function writeProviders(config: ProvidersConfig, file: string = providersFilePath()): void {
	const providers: Record<string, unknown> = {};
	for (const provider of config.providers) {
		const { id, ...rest } = provider;
		// 未停用的模型不写 disabled：配置文件只记录差异，默认值交给解析层
		providers[id] = { ...rest, models: provider.models.map(modelRecord) };
	}
	const source = `${JSON.stringify({ providers }, null, 2)}\n`;

	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, source, "utf8");
		try {
			chmodSync(temporary, 0o600);
		} catch {
			// Windows 没有 POSIX 权限位；写盘结果仍然有效
		}
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** 模型条目落盘形态：只剩停用标记需要显式写出。 */
function modelRecord(model: ModelEntry): Record<string, unknown> {
	const { disabled, ...rest } = model;
	return disabled ? { ...rest, disabled: true } : rest;
}
