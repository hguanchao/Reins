import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin, PluginFailure, PluginHost } from "./host.ts";

/**
 * 外部插件。
 *
 * 从磁盘上的一个目录里发现 .ts 文件并装载。装载走动态 import，所以改完文件重载一次就生效，
 * 既不需要重新编译，也不需要重启——「源码即运行产物」这条约定在这里正好派上用场。
 *
 * 每次装载换一个代号，拼在 import 的地址后面：Node 按地址缓存模块，地址不变就会拿到上一次
 * 求值的结果，文件改了也看不出变化。代号还有第二个用处——它标出「哪一代还作数」，换掉之后
 * 旧的那一代连注册的入口都不再有效（这一层由插件宿主落实）。
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
export function discoverPlugins(directory: string): readonly ExternalPluginSource[] {
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
export async function importPlugin(
	source: ExternalPluginSource,
	generation: number,
): Promise<Plugin> {
	const url = pathToFileURL(source.file);
	url.searchParams.set("generation", String(generation));

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
 * 外部插件的装载与重载。
 *
 * 只做两件事：从目录里发现，按代号 import。装载进注册表这件事由插件宿主负责——宿主才知道
 * 什么该被卸下、旧的那一代什么时候作废。
 */
export class ExternalPlugins {
	readonly #directory: string;
	readonly #host: PluginHost;
	#generation = 0;

	constructor(options: { readonly directory: string; readonly host: PluginHost }) {
		this.#directory = options.directory;
		this.#host = options.host;
	}

	/**
	 * 发现并装载目录里的全部插件。再调用一次就是重载。
	 *
	 * 单个文件装载失败不影响其余文件：一个写坏的插件不该让别的插件也起不来。失败的那一个
	 * 会被卸下——它上一版还在注册表里的话，留着就是「文件明明改坏了，旧的行为却还在」。
	 */
	async load(): Promise<readonly PluginFailure[]> {
		const generation = this.#generation + 1;
		this.#generation = generation;

		const failures: PluginFailure[] = [];
		const plugins: Plugin[] = [];
		for (const source of discoverPlugins(this.#directory)) {
			try {
				plugins.push(await importPlugin(source, generation));
			} catch (error) {
				failures.push({ plugin: source.name, message: describeError(error) });
			}
		}

		return [...failures, ...(await this.#host.loadExternal(plugins))];
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
