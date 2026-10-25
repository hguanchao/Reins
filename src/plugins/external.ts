import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describeError } from "../shared/describe-error.ts";
import type { Plugin, PluginFailure, PluginHost } from "./host.ts";

/**
 * 外部插件。
 *
 * 从磁盘上的一个目录里发现 .ts 文件并装载。装载走动态 import，源码即运行产物：改完文件重启
 * 一次就能生效，既不需要重新编译，也不需要打包。
 */

export interface ExternalPluginSource {
	/** 插件标识，取自文件名 */
	readonly name: string;
	readonly file: string;
}

/**
 * 发现目录里的插件。
 *
 * 目录不存在就当作没有插件：大多数人不会有外部插件，为此报错只会让人以为哪里配错了。
 * 只看顶层的一层 .ts 文件，不递归——插件的标识取自文件名，递归下去就得另发明一套命名规则。
 */
function discoverPlugins(directory: string): readonly ExternalPluginSource[] {
	let names: readonly string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}

	const sources: ExternalPluginSource[] = [];
	for (const name of [...names].sort()) {
		if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
		sources.push({ name: basename(name, extname(name)), file: join(directory, name) });
	}
	return sources;
}

/**
 * 装载一个插件文件。
 *
 * 文件要默认导出一个符合契约的对象。标识必须与文件名一致：禁用清单、界面上的清单都按标识
 * 认人，两处对不上就只能靠猜。
 */
async function importPlugin(source: ExternalPluginSource): Promise<Plugin> {
	const url = pathToFileURL(source.file);

	let module: unknown;
	try {
		module = await import(url.href);
	} catch (error) {
		throw new Error(`Load failed: ${describeError(error)}`);
	}

	const plugin = readPlugin(module);
	if (plugin.name !== source.name) {
		throw new Error(`Plugin id ${plugin.name} does not match the file name ${source.name}`);
	}
	return plugin;
}

function readPlugin(module: unknown): Plugin {
	if (typeof module !== "object" || module === null || !("default" in module)) {
		throw new Error("No default export");
	}
	const value = (module as { readonly default: unknown }).default;
	if (typeof value !== "object" || value === null) throw new Error("The default export is not an object");

	const record = value as Record<string, unknown>;
	if (typeof record["name"] !== "string" || record["name"].length === 0) {
		throw new Error("The default export is missing name");
	}
	if (typeof record["setup"] !== "function") throw new Error("The default export is missing setup");
	return value as Plugin;
}

/**
 * 外部插件的装载。
 *
 * 只做两件事：从目录里发现，逐个 import。装载进注册表这件事由插件宿主负责——信任级别属于
 * 宿主的安全边界，不该由这里决定。
 */
export class ExternalPlugins {
	readonly #directory: string;
	readonly #host: PluginHost;

	constructor(options: { readonly directory: string; readonly host: PluginHost }) {
		this.#directory = options.directory;
		this.#host = options.host;
	}

	/**
	 * 发现并装载目录里的全部插件。
	 *
	 * 单个文件装载失败不影响其余文件：一个写坏的插件不该让别的插件也起不来。
	 */
	async load(): Promise<readonly PluginFailure[]> {
		const failures: PluginFailure[] = [];
		const plugins: Plugin[] = [];
		for (const source of discoverPlugins(this.#directory)) {
			try {
				plugins.push(await importPlugin(source));
			} catch (error) {
				failures.push({ plugin: source.name, message: describeError(error) });
			}
		}

		return [...failures, ...(await this.#host.loadExternal(plugins))];
	}
}

