import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 包名转发文件的统一写入。
 *
 * 插件 `import` 的运行时包名优先用插件 node_modules 里的真包（npm 安装落盘的）；缺失时才写
 * 转发指向宿主内置替身。顺序有讲究：安装流程先 npm install 再写转发，真包落盘后替身不会
 * 遮住它。
 *
 * 转发文件必须是 `.js`：Node 拒绝对 node_modules 下的 TypeScript 做类型剥离，而替身文件在
 * 宿主源码目录里，不受这个限制。内容幂等：没变就不写。
 */

export interface ShimPackage {
	readonly name: string;
	/** 替身文件，相对替身目录 */
	readonly module: string;
}

export function writeForwarders(root: string, shimDir: string, packages: readonly ShimPackage[]): void {
	for (const shim of packages) {
		const directory = join(root, "node_modules", shim.name);
		if (existsSync(directory)) continue;

		const forwarder = `export * from ${JSON.stringify(pathToFileURL(join(shimDir, shim.module)).href)};\n`;
		const manifest = `${JSON.stringify(
			{ name: shim.name, version: "0.0.0-reins", type: "module", exports: { ".": "./index.js" } },
			null,
			2,
		)}\n`;

		writeIfChanged(join(directory, "index.js"), forwarder);
		writeIfChanged(join(directory, "package.json"), manifest);
	}
}

function writeIfChanged(path: string, contents: string): void {
	try {
		if (readFileSync(path, "utf8") === contents) return;
	} catch {
		// 文件不存在：往下写
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents, "utf8");
}
