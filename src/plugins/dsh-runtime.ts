import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isObject } from "./dsh-shim/shared.ts";
import type { DeclarativePlugin } from "./declarative.ts";
import type { Plugin, PluginApi, PluginFailure } from "./host.ts";
import type { ToolResult } from "../tools/contract.ts";
import type { JsonSchema } from "../tools/schema.ts";
import { writeForwarders } from "./shims.ts";
import { contextProxy } from "./missing.ts";

/**
 * dsh 插件的装载器。
 *
 * dsh 插件是 Cordis 体系的模块：`export const inject = [...]` 声明服务，`apply(ctx, config)`
 * 在 ctx 上注册工具与会话投影。dsh 自己的 loader 会在缺服务时拒绝启动——我们的 loader 不做
 * 这件事：`ctx` 由这里构造，缺什么一目了然，插件拿到的服务每个都有真实行为或明确报错。
 *
 * 工具契约不用垫：`@deepseek-ai/dsh-tools` 在 npm 公共源上，安装时随插件落盘，`defineTool`
 * 是真实现；只有它缺失时才转发到内置替身。
 *
 * 已知边界（都会写进装载结果）：会话投影只存内存——dsh 把投影挂进会话事件流供界面重放，
 * Reins 的会话模型不同，数据不落盘；`ctx` 上其余服务（jobs、shell、agents、goals…）调用即
 * 报错。
 */

export interface DshExtensionContext {
	readonly cwd: string;
	readonly mode: "tui" | "print";
	readonly projectTrusted: boolean;
	readonly sessionDir: string;
	/** 扩展往界面上写一行信息；print 模式落 stderr，界面模式进状态 */
	readonly notify: (message: string) => void;
}

export interface DshLoadOutcome {
	readonly tools: readonly string[];
	/** 注册的投影键；数据仅存内存，不写入会话文件 */
	readonly projections: readonly string[];
	/** 登记了但不会派发的事件名 */
	readonly handlers: readonly string[];
	/** 插件登记的系统提示词段；只登记名字，正文未接入 */
	readonly promptSections: readonly string[];
	readonly unavailable: readonly string[];
}

/** dsh 插件 import 的运行时包名：npm 真包优先，缺失时转发到内置替身。 */
const SHIM_PACKAGES: readonly { readonly name: string; readonly module: string }[] = [
	{ name: "@deepseek-ai/dsh-tools", module: "tools.ts" },
	{ name: "@deepseek-ai/cordis", module: "shared.ts" },
];

/** 加载一个 dsh 插件：构造 ctx、执行 apply、返回注册到了什么。 */
export async function loadDshPlugin(input: {
	readonly root: string;
	/** 入口文件；declarative 扫描给的是绝对路径 */
	readonly file: string;
	readonly api: PluginApi;
	readonly context: DshExtensionContext;
}): Promise<DshLoadOutcome> {
	writeForwarders(input.root, join(import.meta.dirname ?? ".", "dsh-shim"), SHIM_PACKAGES);

	const entry = isAbsolute(input.file) ? input.file : join(input.root, input.file);
	const module = (await import(pathToFileURL(entry).href)) as Record<PropertyKey, unknown>;
	const apply = typeof module["apply"] === "function" ? module["apply"] : module["default"];
	if (typeof apply !== "function") {
		throw new Error("The module does not export apply(); dsh plugins export async (ctx, config) => void");
	}

	const runtime = createDshRuntime(input);
	await (apply as (ctx: unknown, config: unknown) => Promise<void> | void)(runtime.ctx, {});
	return runtime.outcome();
}

function createDshRuntime(input: {
	readonly root: string;
	readonly file: string;
	readonly api: PluginApi;
	readonly context: DshExtensionContext;
}): { readonly ctx: unknown; readonly outcome: () => DshLoadOutcome } {
	const tools: string[] = [];
	const projections: string[] = [];
	const handlers: string[] = [];
	const unavailable = new Set<string>();
	const events: { readonly type: string; readonly data: unknown }[] = [];
	const context = input.context;

	const markUnavailable = (name: string): void => {
		unavailable.add(name);
	};

	// 会话事件流只存内存：投影数据不落盘这件事必须让使用者知道，报告里写明
	const session = {
		append: (type: string, data: unknown): void => {
			events.push({ type, data });
		},
	};

	const agent = { session };

	// inject 的回调以当前 ctx 立即执行：宿主的服务在构造时就绪，没有 Cordis 的异步装配阶段
	let ctxRef: unknown;
	/** effect 注册的清理函数；宿主进程退出即结束，无独立卸载时机 */
	const cleanups: (() => unknown)[] = [];
	/** 插件登记的提示词段；第一轮只登记，不接入系统提示词 */
	const promptSections: string[] = [];

	const base: Record<PropertyKey, unknown> = {
		inject: (_names: readonly string[], callback: (injected: unknown) => unknown): unknown => callback(ctxRef),
		// Cordis 的 effect：立即执行 setup，返回值（清理函数）留到卸载时跑——宿主没有卸载时机
		effect: (setup: unknown): unknown => {
			if (typeof setup !== "function") return undefined;
			const cleanup = (setup as () => unknown)();
			if (typeof cleanup === "function") cleanups.push(cleanup as () => unknown);
			return cleanup;
		},
		// 事件只登记不派发：宿主没有 agent/事件点，这条边界进装载结果
		on: (event: unknown, handler: unknown): void => {
			if (typeof handler !== "function") throw new Error("ctx.on expects an event handler function");
			handlers.push(typeof event === "string" ? event : String(event));
		},
		// 宿主已有的服务按名返回，没有的返回 undefined——dsh 插件惯用 `?.` 兜底
		get: (name: unknown): unknown => {
			const service = typeof name === "string" ? base[name] : undefined;
			if (service !== undefined) return service;
			markUnavailable(`ctx.get('${String(name)}')`);
			return undefined;
		},
		// 提示词段只登记：段名进报告，正文不接入系统提示词
		systemPrompt: {
			section: (spec: unknown): (() => void) => {
				const name = isObject(spec) && typeof spec["name"] === "string" ? spec["name"] : "(unnamed)";
				promptSections.push(name);
				return () => {};
			},
		},
		tools: {
			register: (candidate: unknown): void => {
				const tool = dshToolToReins(candidate, agent);
				input.api.registerTool(tool);
				tools.push(tool.name);
			},
			// 工具执行守卫：dsh 语义是注册一个拦截器并返回反注册函数；宿主没有拦截点
			guard: (_interceptor: unknown): (() => void) => {
				markUnavailable("ctx.tools.guard");
				return () => {};
			},
		},
		sessionProjections: {
			register: (spec: unknown): Promise<void> => {
				const key = isObject(spec) && typeof spec["key"] === "string" ? spec["key"] : "(unnamed)";
				projections.push(key);
				return Promise.resolve();
			},
		},
		logger: {
			info: (message: string) => context.notify(`[dsh] ${message}`),
			warn: (message: string) => context.notify(`[dsh] ${message}`),
			error: (message: string) => context.notify(`[dsh] ${message}`),
			debug: () => {},
		},
	};

	const ctx = contextProxy(base, "ctx", markUnavailable);
	ctxRef = ctx;

	return {
		ctx,
		outcome: () => ({
			tools: [...tools],
			projections: [...projections],
			handlers: [...handlers],
			promptSections: [...promptSections],
			unavailable: [...unavailable].sort(),
		}),
	};
}

type DshExecute = (args: Record<string, unknown>, exec: unknown) => Promise<unknown> | unknown;

/** dsh 工具定义转成宿主契约；外部声明一律按不可信处理，只读与破坏性标注从保守。 */
function dshToolToReins(
	candidate: unknown,
	agent: { session: { append: (type: string, data: unknown) => void } },
): {
	name: string;
	description: string;
	parameters: JsonSchema;
	annotations: { readOnly: boolean; destructive: boolean; openWorld: boolean };
	execute: (harness: ToolHarness) => Promise<ToolResult>;
} {
	if (!isObject(candidate)) throw new Error("ctx.tools.register expects a tool object");

	const name = typeof candidate["name"] === "string" ? candidate["name"] : "";
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
		throw new Error(`Invalid tool name: ${JSON.stringify(candidate["name"])}`);
	}
	const execute = candidate["execute"];
	if (typeof execute !== "function") throw new Error(`Tool ${name} must define execute`);

	const description = typeof candidate["description"] === "string" ? candidate["description"] : "";
	const parameters = isObject(candidate["parameters"]) ? candidate["parameters"] : { type: "object", properties: {} };
	const output = isObject(candidate["output"]) ? candidate["output"] : undefined;

	return {
		name,
		description,
		parameters: parameters as unknown as JsonSchema,
		annotations: { readOnly: false, destructive: true, openWorld: true },
		async execute(harness: ToolHarness): Promise<ToolResult> {
			const exec = {
				agent,
				callId: harness.callId,
				rootCallId: harness.callId,
				signal: harness.signal,
			};
			const value = await (execute as DshExecute)(harness.args, exec);
			return toReinsResult(value, harness.args, output, name);
		},
	};
}

interface ToolHarness {
	readonly callId: string;
	readonly args: Record<string, unknown>;
	readonly signal: AbortSignal;
	readonly onUpdate: (text: string) => void;
}

function toReinsResult(
	value: unknown,
	args: Record<string, unknown>,
	output: unknown,
	tool: string,
): ToolResult {
	const blocks = renderBlocks(value, args, output);
	const parts: string[] = [];
	for (const block of blocks) {
		const textPart = blockText(block);
		if (textPart !== undefined) parts.push(textPart);
	}
	return {
		content: parts.length === 0 ? `(tool ${tool} produced no output)` : parts.join("\n"),
		...(value === undefined ? {} : { details: value }),
	};
}

function renderBlocks(value: unknown, args: Record<string, unknown>, output: unknown): readonly unknown[] {
	if (!isObject(output) || typeof output["render"] !== "function") {
		// 插件没写渲染器时把结果原样序列化，模型至少能看到发生了什么
		return [{ type: "text", text: JSON.stringify(value, null, 2) ?? "null" }];
	}
	const rendered = (output["render"] as (args: unknown, value: unknown) => unknown)(args, value);
	return Array.isArray(rendered) ? rendered : [];
}

function blockText(block: unknown): string | undefined {
	if (!isObject(block)) return undefined;
	if (block["type"] === "text" && typeof block["text"] === "string") return block["text"];
	if (block["type"] === "image") return "[image]";
	return undefined;
}

/**
 * 把一个带 dsh 扩展的声明式插件包装成宿主认识的外部插件。
 *
 * 与 pi 扩展同一条管线：同一信任级别、同一失败收集、同一份重名与残缺防护。
 */
export interface DshExtensionCollector {
	readonly plugin: Plugin;
	readonly outcomes: readonly DshLoadOutcome[];
}

export function dshExtensionPlugin(
	plugin: DeclarativePlugin,
	context: DshExtensionContext,
): DshExtensionCollector {
	const outcomes: DshLoadOutcome[] = [];

	return {
		plugin: {
			name: plugin.name,
			setup: async (api: PluginApi) => {
				for (const file of plugin.extensions) {
					const outcome = await loadDshPlugin({ root: plugin.root, file, api, context });
					outcomes.push(outcome);
				}
			},
		},
		outcomes,
	};
}

/** dsh 插件的装载结论：注册的工具、只存内存的投影、不可用的服务与失败。 */
export function describeDshOutcomes(
	collectors: readonly DshExtensionCollector[],
	failures: readonly PluginFailure[],
): readonly string[] {
	const lines: string[] = [];
	for (const collector of collectors) {
		for (const outcome of collector.outcomes) {
			const parts: string[] = [];
			if (outcome.tools.length > 0) parts.push(`tools: ${outcome.tools.join(", ")}`);
			if (outcome.projections.length > 0) {
				parts.push(`in-memory projections: ${outcome.projections.join(", ")}`);
			}
			if (outcome.handlers.length > 0) {
				parts.push(
					`${outcome.handlers.length} event(s) registered but not dispatched: ${outcome.handlers.join(", ")}`,
				);
			}
			if (outcome.promptSections.length > 0) {
				parts.push(`prompt sections (registered, not applied): ${outcome.promptSections.join(", ")}`);
			}
			lines.push(
				`dsh plugin ${collector.plugin.name}: ${
					parts.length === 0 ? "nothing registered" : parts.join("; ")
				}`,
			);
			lines.push(
				`dsh plugin ${collector.plugin.name}: projection data is kept in memory only and is not written to the session file`,
			);
			for (const name of outcome.unavailable) {
				lines.push(`dsh plugin ${collector.plugin.name}: unavailable — ${name}`);
			}
		}
	}
	for (const failure of failures) {
		lines.push(`dsh plugin ${failure.plugin}: failed — ${failure.message}`);
	}
	return lines;
}
