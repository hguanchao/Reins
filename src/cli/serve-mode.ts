import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeError } from "#src/shared/describe-error.ts";
import { loadSelection } from "#src/cli/config-selection.ts";
import type { CliOptions } from "#src/cli/args.ts";
import { writeStderr } from "#src/cli/output.ts";
import {
	assemblePipeline,
	createCompactor,
	createDriverFor,
	createReviewer,
} from "#src/cli/pipeline.ts";
import { createSessionFor } from "#src/cli/session/factory.ts";
import {
	defaultInstructionSources,
	readInstructions,
	type PromptInstruction,
} from "#src/agent/instructions.ts";
import { ApprovalBroker } from "#src/permission/approval.ts";
import { PermissionGate, PermissionPolicy, type ApprovalAnswer } from "#src/permission/policy.ts";
import { WorkspaceBoundary } from "#src/workspace/boundary.ts";
import type { McpControl } from "#src/mcp/service.ts";
import { createWebServer, type WebServerDeps } from "#src/web/server.ts";

/**
 * 浏览器界面模式。
 *
 * 装配与非交互模式同一条管线(审批、工具、插件与沙箱只有一份),差别在两端:审批经
 * ApprovalBroker 交由网页回传,事件经 SSE 推给浏览器。整个进程一个会话,回合一次跑一个,
 * 正在跑的时候新提交按 409 拒绝——排队语义留给界面侧自己处理,这里不做隐藏队列。
 */

/** 审批结论的合法取值;传输层只给字符串,这里收窄后才准进审批桥。 */
const APPROVAL_ANSWERS: readonly ApprovalAnswer[] = ["once", "always", "deny"];

export async function runServeMode(options: CliOptions): Promise<number> {
	const loaded = await loadSelection(options);
	if (!loaded.ok) {
		writeStderr(`${loaded.error.display}\n`);
		return 1;
	}
	const { config, selection } = loaded.value;

	const workRoot = process.cwd();
	const workspace = new WorkspaceBoundary(workRoot);
	const instructions = (): readonly PromptInstruction[] =>
		readInstructions(defaultInstructionSources(workRoot, loaded.trusted));

	// 审批链路与全屏界面同构:策略先立起来,审查模型懒封装,决定靠网页回传
	const approvals = new ApprovalBroker();
	const policy = new PermissionPolicy(config.approval);
	const gate = new PermissionGate({
		policy,
		reviewer: config.approval === "auto" ? createReviewer(config, selection, workRoot) : undefined,
		confirmer: approvals.request,
	});

	let mcpControl: McpControl | undefined;
	const pipeline = await assemblePipeline({
		config,
		workRoot,
		policy,
		gate,
		extensionContext: { mode: "tui", projectTrusted: loaded.trusted },
		onMcpControl: (control) => {
			mcpControl = control;
		},
	});
	if (pipeline === null) return 1;
	const { registry, sandbox, sandboxWarnings, host } = pipeline;
	for (const warning of sandboxWarnings) writeStderr(`${warning}\n`);
	for (const line of pipeline.pluginReport) writeStderr(`reins: ${line.text}\n`);

	const session = createSessionFor(workRoot, host.sessionStore());
	const compactor = createCompactor(config, selection);

	// 事件广播:装配层的 AgentEvent 原样转发,浏览器是又一个消费方
	const listeners = new Set<(event: unknown) => void>();
	const broadcast = (event: unknown): void => {
		for (const listener of listeners) listener(event);
	};

	// ApprovalBroker 没有变更回调,全屏界面也是每帧看一眼;这里按 100ms 巡检,
	// 当前请求变化才发事件,不往事件流里塞重复内容
	let lastApprovalId: number | undefined;
	const approvalTimer = setInterval(() => {
		const id = approvals.pendingId();
		if (id === lastApprovalId) return;
		broadcast(
			id === undefined
				? { type: "approval_cleared" }
				: { type: "approval_request", id, request: approvals.pending() },
		);
		lastApprovalId = id;
	}, 100);
	approvalTimer.unref();

	// 一次只跑一个回合;在跑的回合的句柄留给退出与状态查询
	let running = false;
	let currentAbort: AbortController | undefined;
	let currentRun: Promise<void> | undefined;

	const deps: WebServerDeps = {
		snapshot: () => {
			const id = approvals.pendingId();
			return {
				running,
				approval: id === undefined ? undefined : { id, request: approvals.pending() },
			};
		},
		session: () => ({ id: session.id, cwd: session.cwd, entries: session.entries() }),
		submit: (text) => {
			if (running) return false;
			running = true;
			currentAbort = new AbortController();
			currentRun = (async () => {
				try {
					const driver = createDriverFor(
						{ config, selection, compactor },
						{ registry, session, workspace, sandbox, instructions },
						(event) => broadcast(event),
					);
					// 首条消息前等 MCP 握手收口:不拿半套工具清单发第一次请求
					await mcpControl?.awaitStartup();
					await driver.run(text, currentAbort!.signal);
				} catch (error) {
					// 抛到这一层的是装配或驱动本身的意外;照发成事件,流里不留没有结论的开头
					broadcast({ type: "error", message: describeError(error) });
				} finally {
					running = false;
					currentAbort = undefined;
					currentRun = undefined;
				}
			})();
			return true;
		},
		abort: () => {
			currentAbort?.abort();
		},
		approval: {
			resolve: (id, answer) => {
				if (!APPROVAL_ANSWERS.includes(answer as ApprovalAnswer)) return;
				approvals.resolve(answer as ApprovalAnswer, id);
			},
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		// 界面构建产物在仓库根的 web/dist;没构建时传 undefined,服务端自己给指引页
		staticRoot: staticRoot(),
	};

	const token = randomBytes(16).toString("base64url");
	const server = await createWebServer(deps, { token, port: options.port ?? 8787 }).start();
	writeStderr(`Reins 界面: http://127.0.0.1:${server.port}/?token=${token}\n`);
	writeStderr(`会话: ${session.id}\n`);
	writeStderr("Ctrl+C 退出\n");

	const exitCode = await new Promise<number>((resolveRun) => {
		process.once("SIGINT", () => {
			void (async () => {
				// 先停回合再收尾:驱动要落地最后一批会话写入,不能与 close 赛跑
				currentAbort?.abort();
				if (currentRun !== undefined) {
					await Promise.race([
						currentRun,
						new Promise<void>((resolveWait) => {
							const timer = setTimeout(resolveWait, 2000);
							timer.unref();
						}),
					]);
				}
				// 等审批的工具线程按拒绝放掉,别让它们挂死
				approvals.denyAll();
				clearInterval(approvalTimer);
				await server.close();
				resolveRun(0);
			})();
		});
	});
	await session.close();
	return exitCode;
}

/** 从本文件位置推导仓库根下的 web/dist;推导不出或不存在时返回 undefined。 */
function staticRoot(): string | undefined {
	const root = fileURLToPath(new URL("../../web/dist", import.meta.url));
	return existsSync(root) ? root : undefined;
}
