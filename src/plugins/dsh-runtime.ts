import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isObject } from "./dsh-shim/shared.ts";
import type { DeclarativePlugin } from "./declarative.ts";
import type { Plugin, PluginApi, PluginFailure } from "./host.ts";
import type { ToolContext, ToolResult } from "../tools/contract.ts";
import type { JsonSchema } from "../tools/schema.ts";
import { writeForwarders } from "./shims.ts";
import { describeError } from "../shared/describe-error.ts";
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
	/** Reins 沙箱模式映射成 dsh 的策略模式；worker 的文件边界由此决定 */
	readonly policyMode: "read-only" | "workspace-write" | "danger-full-access";
	/** 扩展往界面上写一行信息；print 模式落 stderr，界面模式进状态 */
	readonly notify: (message: string) => void;
}

export interface DshLoadOutcome {
	readonly tools: readonly string[];
	/** 注册的投影键；数据仅存内存，不写入会话文件 */
	readonly projections: readonly string[];
	/** 登记的事件名（agent/created 在装载完成后派发一次） */
	readonly handlers: readonly string[];
	/** 派发过程中的非致命问题 */
	readonly warnings: readonly string[];
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
	// 插件导出的 schemastery Config 能从空对象解析出默认值；解析失败（必填未提供）则保持空
	let config: Record<string, unknown> = {};
	try {
		const parsed = (module["Config"] as unknown as ((input: unknown) => unknown) | undefined)?.({});
		if (isObject(parsed)) config = parsed;
	} catch {
		// 必填项缺失：config 保持空，插件按 undefined 运行
	}
	await (apply as (ctx: unknown, config: unknown) => Promise<void> | void)(runtime.ctx, config);
	// dsh 的工具按会话生命周期发布：装载完成后以「agent 已创建」派发一次，让发布逻辑跑起来，
	// 再等发布收敛（worker 启动与注册是异步的）。派发失败只记警告，不杀整个装载。
	runtime.dispatchAgentCreated();
	await runtime.settle();
	return runtime.outcome();
}

function createDshRuntime(input: {
	readonly root: string;
	readonly file: string;
	readonly api: PluginApi;
	readonly context: DshExtensionContext;
}): {
	readonly ctx: unknown;
	readonly dispatchAgentCreated: () => void;
	readonly settle: () => Promise<void>;
	readonly outcome: () => DshLoadOutcome;
} {
	const tools: string[] = [];
	const projections: string[] = [];
	const registered: { readonly event: string; readonly handler: (payload: unknown) => unknown }[] = [];
	const warnings: string[] = [];
	const unavailable = new Set<string>();
	const events: { readonly type: string; readonly data: unknown }[] = [];
	const context = input.context;

	const markUnavailable = (name: string): void => {
		unavailable.add(name);
	};

	// 会话事件流只存内存：投影数据不落盘这件事必须让使用者知道，报告里写明
	const session = {
		id: "",
		cwd: context.cwd,
		header: { cwd: context.cwd },
		append: (type: string, data: unknown): void => {
			events.push({ type, data });
		},
	};

	// inject 的回调以当前 ctx 立即执行：宿主的服务在构造时就绪，没有 Cordis 的异步装配阶段
	let ctxRef: unknown;
	/** effect 注册的清理函数；宿主进程退出即结束，无独立卸载时机 */
	const cleanups: (() => unknown)[] = [];
	/** 插件登记的提示词段；第一轮只登记，不接入系统提示词 */
	const promptSections: string[] = [];

	const base: Record<PropertyKey, unknown> = {
		inject: (_names: readonly string[], callback: (injected: unknown) => unknown): unknown => callback(ctxRef),
		// Cordis 的子作用域：立即以当前 ctx 执行 apply，返回 thenable 供插件 await
		plugin: (spec: unknown): Promise<unknown> => {
			if (isObject(spec) && typeof spec["apply"] === "function") {
				const applied = (spec["apply"] as (scoped: unknown) => unknown)(ctxRef);
				if (applied instanceof Promise) return applied.then(() => ctxRef);
			}
			return Promise.resolve(ctxRef);
		},
		// Cordis 的 effect：立即执行 setup，返回值（清理函数）留到卸载时跑——宿主没有卸载时机
		effect: (setup: unknown): unknown => {
			if (typeof setup !== "function") return undefined;
			const cleanup = (setup as () => unknown)();
			if (typeof cleanup === "function") cleanups.push(cleanup as () => unknown);
			return cleanup;
		},
		// 事件登记后由宿主在对应时机派发（agent/created 在装载完成后派发一次）；其余不派发
		on: (event: unknown, handler: unknown): void => {
			if (typeof handler !== "function") throw new Error("ctx.on expects an event handler function");
			registered.push({ event: String(event), handler: handler as (payload: unknown) => unknown });
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
				const tool = dshToolToReins(candidate, events);
				input.api.registerTool(tool);
				tools.push(tool.name);
			},
			// 工具执行守卫：dsh 语义是注册一个拦截器并返回反注册函数；宿主没有拦截点
			guard: (_interceptor: unknown): (() => void) => {
				markUnavailable("ctx.tools.guard");
				return () => {};
			},
		},
		// dsh worker 的文件边界由这份策略决定：Reins 的沙箱模式原样映射，不做放宽
		sandboxPolicy: {
			resolve: (_input: unknown) => ({
				mode: context.policyMode,
				workspaceRoot: context.cwd,
			}),
		},
		// dsh 的受管子进程：worker exe 的进程创建与输出收集。文件边界由 worker 按传入的策略
		// 自行执行，宿主只负责把进程跑起来并按字节预算收集输出。
		subprocess: {
			spawn: (request: unknown): unknown => spawnManaged(request),
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
		dispatchAgentCreated: (): void => {
			const payload = { agent: { ctx: ctxRef, session } };
			for (const { event, handler } of registered) {
				if (event !== "agent/created") continue;
				try {
					handler(payload);
				} catch (error) {
					warnings.push(`agent/created handler failed: ${describeError(error)}`);
				}
			}
		},
		// 发布是异步的（fiber → worker 启动 → 注册）：等工具数量连续多个轮询不再增长，
		// 或到达上限，再产出装载结论
		settle: async (): Promise<void> => {
			await new Promise<void>((resolve) => {
				let last = tools.length;
				let stable = 0;
				const timer = setInterval(() => {
					if (tools.length === last) {
						stable += 1;
						if (stable >= 5) {
							clearInterval(timer);
							resolve();
						}
					} else {
						last = tools.length;
						stable = 0;
					}
				}, 100);
				setTimeout(() => {
					clearInterval(timer);
					resolve();
				}, 3000);
			});
		},
		outcome: () => ({
			tools: [...tools],
			projections: [...projections],
			handlers: registered.map((item) => item.event),
			promptSections: [...promptSections],
			warnings: [...warnings],
			unavailable: [...unavailable].sort(),
		}),
	};
}

type DshExecute = (args: Record<string, unknown>, exec: unknown) => Promise<unknown> | unknown;

/**
 * dsh 工具定义转成宿主契约；外部声明一律按不可信处理，只读与破坏性标注从保守。
 *
 * dsh 的权限层以 `exec.agent.session.id` 为权威会话身份（会话临时目录、调用预算都挂在它上），
 * 所以 agent 按次构造，id 来自 Reins 的真实会话；事件流仍是内存实现。
 */
function dshToolToReins(
	candidate: unknown,
	events: { readonly type: string; readonly data: unknown }[],
): {
	name: string;
	description: string;
	parameters: JsonSchema;
	annotations: { readOnly: boolean; destructive: boolean; openWorld: boolean };
	execute: (context: ToolContext<Record<string, unknown>>) => Promise<ToolResult>;
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
		async execute(context: ToolContext<Record<string, unknown>>): Promise<ToolResult> {
			const exec = {
				agent: {
					session: {
						id: context.session.id,
						cwd: context.workspace.root,
						header: { cwd: context.workspace.root },
						append: (type: string, data: unknown): void => {
							events.push({ type, data });
						},
					},
				},
				callId: context.callId,
				rootCallId: context.callId,
				signal: context.signal,
			};
			const value = await (execute as DshExecute)(context.args, exec);
			return toReinsResult(value, context.args, output, name);
		},
	};
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
			if (outcome.handlers.length > 0) parts.push(`events: ${outcome.handlers.join(", ")}`);
			if (outcome.warnings.length > 0) {
				for (const warning of outcome.warnings) {
					lines.push(`dsh plugin ${collector.plugin.name}: warning — ${warning}`);
				}
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

/**
 * dsh 的受管子进程：按请求启动、收集限长输出、报告退出状态。
 *
 * 输出超过预算的部分被丢弃并标记 lossy——调用方（worker 协议）会把它当作不可信结果处理，
 * 这里不做静默截断拼接。
 */
function spawnManaged(request: unknown): unknown {
	if (!isObject(request) || !Array.isArray(request["argv"])) {
		throw new Error("subprocess.spawn expects { argv, ... }");
	}
	const argv = request["argv"].map((item) => String(item));
	const stdio = isObject(request["stdio"]) ? request["stdio"] : {};
	const stdoutBudget = byteBudget(isObject(stdio["stdout"]) ? stdio["stdout"] : undefined);
	const stderrBudget = byteBudget(isObject(stdio["stderr"]) ? stdio["stderr"] : undefined);

	const child = spawn(argv[0]!, argv.slice(1), {
		cwd: typeof request["cwd"] === "string" ? request["cwd"] : undefined,
		windowsHide: true,
		...(request["signal"] instanceof AbortSignal ? { signal: request["signal"] } : {}),
	});

const collected = {
		stdout: collect(child.stdout, stdoutBudget),
		stderr: collect(child.stderr, stderrBudget),
	};

	const stdinSpec = isObject(stdio["stdin"]) ? stdio["stdin"] : undefined;
	if (stdinSpec && stdinSpec["data"] !== undefined) {
		child.stdin?.end(stdinSpec["data"] as string);
	} else {
		child.stdin?.end();
	}

	const done = new Promise<Record<string, unknown>>((resolve) => {
		child.on("error", () => resolve({ exitCode: -1 }));
		child.on("close", (code, signalName) => resolve({ ...(code === null ? {} : { exitCode: code }), ...(signalName === null ? {} : { signal: signalName }) }));
	});

	return { done, collected, kill: () => child.kill() };
}

function byteBudget(spec: Record<PropertyKey, unknown> | undefined): number | undefined {
	const value = spec?.["maxBytes"];
	return typeof value === "number" && value > 0 ? value : undefined;
}

/** 限长收集一个输出流：超出预算的字节丢弃并标 lossy。 */
function collect(stream: NodeJS.ReadableStream | null, budget: number | undefined): {
	readonly readFrom: (offset: number) => { readonly text: string; readonly lossy: boolean };
} {
	const chunks: Buffer[] = [];
	let bytes = 0;
	let lossy = false;
	stream?.on("data", (chunk: Buffer) => {
		let piece = chunk as Buffer;
		if (budget !== undefined && bytes + piece.length > budget) {
			piece = piece.subarray(0, Math.max(0, budget - bytes));
			lossy = true;
		}
		if (piece.length === 0) return;
		bytes += piece.length;
		chunks.push(piece);
	});
	return {
		readFrom: (offset: number) => {
			const text = Buffer.concat(chunks).subarray(Math.max(0, offset)).toString("utf8");
			return { text, lossy };
		},
	};
}
