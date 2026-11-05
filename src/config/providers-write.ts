import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { providersFilePath } from "#src/config/paths.ts";
import type { ProvidersConfig } from "#src/config/providers-file.ts";

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
		providers[id] = rest;
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
