import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { writeForwarders } from "./shims.ts";
import { contextProxy } from "./missing.ts";

import type { JsonSchema } from "../tools/schema.ts";
import type { ToolResult } from "../tools/contract.ts";
import type { Plugin, PluginApi, PluginFailure } from "./host.ts";
import type { DeclarativePlugin } from "./declarative.ts";
import { CONFIG_DIR_NAME, getAgentDir, isToolCallEventType, withFileMutationQueue } from "./pi-shim/api.ts";

/**
 * pi 扩展的装载器。
 *
 * 扩展是 TS 源码，`import` 的是 pi 的运行时包；宿主没有那个包，所以在插件目录下补一份
 * `node_modules`，把包名转发到这里内置的替身。转发只在缺文件或内容变化时写一次。
 *
 * 能接住的部分：`registerTool` 与 `registerCommand`。事件（`pi.on`）只计数不派发——宿主还没有
 * 工具调用事件点，静默吞掉会让人以为钩子在生效。`ctx.ui` 只实现 `notify`，其余方法调用即报错；
 * 所有缺口都会记进装载结果，由调用方写进报告。
 */

export interface PiExtensionContext {
	readonly cwd: string;
	readonly mode: "tui" | "print";
	readonly projectTrusted: boolean;
	readonly sessionDir: string;
	/** 扩展往界面上写一行信息；print 模式落 stderr，界面模式进状态 */
	readonly notify: (message: string) => void;
}

export interface PiLoadOutcome {
	readonly tools: readonly string[];
	readonly commands: readonly string[];
	/** 注册了但不会派发的事件处理器数量 */
	readonly handlers: number;
	/** 被调用过但不存在的 pi API，按名字去重排序 */
	readonly unavailable: readonly string[];
}

/** 转发给扩展的包名 → 宿主内置的替身文件（相对替身目录）。 */
const SHIM_PACKAGES: readonly { readonly name: string; readonly module: string }[] = [
	{ name: "@earendil-works/pi-coding-agent", module: "api.ts" },
	{ name: "typebox", module: "typebox.ts" },
	{ name: "@earendil-works/pi-ai", module: "pi-ai.ts" },
];

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * 在插件根下铺好包名解析用的转发文件。
 *
 * npm 安装落盘的真包优先（转发只补缺失）；转发文件是 `.js`——Node 拒绝对 node_modules 下的
 * TypeScript 做类型剥离，而替身文件在宿主源码目录里，不受这个限制。内容幂等：没变就不写。
 */
export function ensureShimPackages(root: string, shimDir: string = join(import.meta.dirname ?? ".", "pi-shim")): void {
	writeForwarders(root, shimDir, SHIM_PACKAGES);
}

/** 加载一个 pi 扩展：构造 `pi` 对象、执行默认导出、返回注册到了什么。 */
export async function loadPiExtension(input: {
	readonly root: string;
	/** 入口文件；declarative 扫描给的是绝对路径，扩展自述时也可以是相对插件根的路径 */
	readonly file: string;
	readonly api: PluginApi;
	readonly context: PiExtensionContext;
}): Promise<PiLoadOutcome> {
	ensureShimPackages(input.root);

	const entry = isAbsolute(input.file) ? input.file : join(input.root, input.file);
	const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
	const setup = module.default;
	if (typeof setup !== "function") {
		throw new Error("The default export is not a function; pi extensions export (pi) => void");
	}

	const runtime = createPiRuntime(input);
	await setup(runtime.pi);
	return runtime.outcome();
}

function createPiRuntime(input: {
	readonly root: string;
	readonly file: string;
	readonly api: PluginApi;
	readonly context: PiExtensionContext;
}): { readonly pi: unknown; readonly outcome: () => PiLoadOutcome } {
	const tools: string[] = [];
	const commands: string[] = [];
	let handlers = 0;
	const unavailable = new Set<string>();
	const context = input.context;

	const markUnavailable = (name: string): void => {
		unavailable.add(name);
	};

	// 会话状态只暴露真的能对应上的两个方法，其余调用即报错并记进报告
	const sessionManager = (): unknown =>
		contextProxy(
			{ getCwd: () => context.cwd, getSessionDir: () => context.sessionDir },
			"ctx.sessionManager",
			markUnavailable,
		);

	const ui = (): unknown =>
		contextProxy({ notify: (message: string) => context.notify(message) }, "ctx.ui", markUnavailable);

	const toolContext = (): unknown =>
		contextProxy(
			{
				cwd: context.cwd,
				mode: context.mode,
				hasUI: true,
				isProjectTrusted: () => context.projectTrusted,
				ui: ui(),
				sessionManager: sessionManager(),
			},
			"ctx",
			markUnavailable,
		);

	const commandContext = (): unknown =>
		contextProxy(
			{
				cwd: context.cwd,
				mode: context.mode,
				hasUI: context.mode === "tui",
				isProjectTrusted: () => context.projectTrusted,
				ui: ui(),
				sessionManager: sessionManager(),
			},
			"ctx",
			markUnavailable,
		);

	const base: Record<PropertyKey, unknown> = {
		registerTool(candidate: unknown): void {
			if (!isObject(candidate)) throw new Error("registerTool expects a tool object");

			const name = text(candidate["name"]);
			if (name === undefined || !TOOL_NAME_PATTERN.test(name)) {
				throw new Error(`Invalid tool name: ${JSON.stringify(candidate["name"])}`);
			}
			const execute = candidate["execute"];
			if (typeof execute !== "function") throw new Error(`Tool ${name} must define execute`);

			const summary = text(candidate["promptSnippet"]);
			input.api.registerTool({
				name,
				...(summary === undefined ? {} : { summary }),
				description: text(candidate["description"]) ?? "",
				parameters: isObject(candidate["parameters"])
					? (candidate["parameters"] as unknown as JsonSchema)
					: { type: "object", properties: {} },
				// 扩展声明的工具走外部信任级别，只读与破坏性标注一律从保守
				annotations: { readOnly: false, destructive: true, openWorld: true },
				...(typeof candidate["prepareArguments"] === "function"
					? {
							prepareArguments: candidate["prepareArguments"] as (
								args: Record<string, unknown>,
							) => Record<string, unknown>,
						}
					: {}),
				async execute(harness): Promise<ToolResult> {
					const outcome = await (execute as PiExecute)(
						harness.callId,
						harness.args,
						harness.signal,
						harness.onUpdate,
						toolContext(),
					);
					return toReinsResult(outcome, name);
				},
			});
			tools.push(name);
		},

		registerCommand(name: unknown, options: unknown): void {
			const commandName = text(name);
			if (commandName === undefined || !COMMAND_NAME_PATTERN.test(commandName)) {
				throw new Error(`Invalid command name: ${JSON.stringify(name)}`);
			}
			if (!isObject(options) || typeof options["handler"] !== "function") {
				throw new Error(`Command /${commandName} must define handler`);
			}
			const handler = options["handler"] as (args: string, ctx: unknown) => Promise<void>;

			input.api.registerCommand({
				name: commandName,
				description: text(options["description"]) ?? "",
				run: async (args) => {
					await handler(args, commandContext());
				},
			});
			commands.push(commandName);
		},

		on(_event: unknown, handler: unknown): void {
			if (typeof handler !== "function") throw new Error("pi.on expects an event handler function");
			handlers += 1;
		},

		appendEntry(): void {
			markUnavailable("pi.appendEntry");
		},

		isToolCallEventType,
		CONFIG_DIR_NAME,
		getAgentDir,
		withFileMutationQueue,
	};

	const pi = new Proxy(base, {
		get(target, property) {
			if (property === "then") return undefined;
			if (property in target) return target[property];
			const name = `pi.${String(property)}`;
			return (..._args: unknown[]): never => {
				markUnavailable(name);
				throw new Error(`${name} is not available in Reins`);
			};
		},
	});

	return {
		pi,
		outcome: () => ({
			tools: [...tools],
			commands: [...commands],
			handlers,
			unavailable: [...unavailable].sort(),
		}),
	};
}

type PiExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
	onUpdate: (text: string) => void,
	ctx: unknown,
) => Promise<unknown>;

/** pi 的结果块转成宿主的纯文本结果；图片块只留占位。 */
function toReinsResult(value: unknown, tool: string): ToolResult {
	if (!isObject(value)) return { content: `(tool ${tool} returned no content)` };

	const blocks = Array.isArray(value["content"]) ? value["content"] : [];
	const parts: string[] = [];
	for (const block of blocks) {
		const textPart = blockText(block);
		if (textPart !== undefined) parts.push(textPart);
	}

	return {
		content: parts.length === 0 ? `(tool ${tool} produced no output)` : parts.join("\n"),
		...(value["isError"] === true ? { isError: true } : {}),
		...(value["details"] === undefined ? {} : { details: value["details"] }),
	};
}

function blockText(block: unknown): string | undefined {
	if (!isObject(block)) return undefined;
	if (block["type"] === "text" && typeof block["text"] === "string") return block["text"];
	if (block["type"] === "image") return "[image]";
	return undefined;
}

/** 缺失成员的统一处理：访问即返回「调用就报错」的函数，完整名字记进装载结果。 */


function isObject(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 把一个带扩展的声明式插件包装成宿主认识的外部插件。
 *
 * 走 `loadExternal` 这条管线是有意的：同一信任级别、同一失败收集、同一份重名与残缺防护。
 * 装载结果从闭包里取，报告由调用方在装载完成后拼。
 */
export interface PiExtensionCollector {
	readonly plugin: Plugin;
	readonly outcomes: readonly PiLoadOutcome[];
}

export function piExtensionPlugin(
	plugin: DeclarativePlugin,
	context: PiExtensionContext,
): PiExtensionCollector {
	const outcomes: PiLoadOutcome[] = [];

	return {
		plugin: {
			name: plugin.name,
			setup: async (api: PluginApi) => {
				for (const file of plugin.extensions) {
					const outcome = await loadPiExtension({ root: plugin.root, file, api, context });
					outcomes.push(outcome);
				}
			},
		},
		outcomes,
	};
}

/** pi 扩展的装载结论：注册到了什么、哪些 API 没接住、装载失败的插件。 */
export function describePiOutcomes(
	collectors: readonly PiExtensionCollector[],
	failures: readonly PluginFailure[],
): readonly string[] {
	const lines: string[] = [];
	for (const collector of collectors) {
		for (const outcome of collector.outcomes) {
			const parts: string[] = [];
			if (outcome.tools.length > 0) parts.push(`tools: ${outcome.tools.join(", ")}`);
			if (outcome.commands.length > 0) parts.push(`commands: /${outcome.commands.join(", /")}`);
			if (outcome.handlers > 0) {
				parts.push(`${outcome.handlers} event handler(s) registered but not dispatched`);
			}
			lines.push(
				`pi extension in ${collector.plugin.name}: ${
					parts.length === 0 ? "nothing registered" : parts.join("; ")
				}`,
			);
			for (const name of outcome.unavailable) {
				lines.push(`pi extension in ${collector.plugin.name}: unavailable — ${name}`);
			}
		}
	}
	for (const failure of failures) {
		lines.push(`pi extension ${failure.plugin}: failed — ${failure.message}`);
	}
	return lines;
}
