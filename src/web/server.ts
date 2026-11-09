import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { PLUGIN_LOG_LIMIT, type PluginLogLine } from "#src/plugins/logs.ts";
import { MAX_SKILL_ARCHIVE_BYTES } from "#src/skills/upload.ts";
import type { FileContent, FileSearchHit, FileTree } from "#src/web/files.ts";
import type { McpServerDraft } from "#src/web/mcp-servers.ts";
import type { ProviderView } from "#src/web/providers.ts";
import {
	parseSettingsUpdate,
	type SettingsSkill,
	type SettingsSnapshot,
	type SettingsUpdate,
} from "#src/web/settings.ts";
import type { GitStatus } from "#src/workspace/git.ts";

/**
 * 浏览器界面的本地服务:纯传输层。
 *
 * 这一屏只认识「命令 + 事件流」与回环安全,不认识内核里的任何类型——它把提交、中断、审批
 * 结论原样转交给装配层,把装配层推来的事件原样写给浏览器。内核类型不进这里,传输协议才能
 * 单独测试,桌面壳(阶段二)也才能照抄这一屏。
 *
 * 只服务回环地址:令牌挡住本机其他进程与网页伪造的请求,Host 校验挡住 DNS rebinding。
 */

/** 服务端推给浏览器的 event 的形状由装配层决定;传输层只负责序列化。 */
export type WebEvent = unknown;

/** 带宽护栏:一条提交(可能带粘贴的长文)的最大字节数。 */
const MAX_BODY_BYTES = 1_000_000;
/** SSE 心跳间隔:只为了让中间层别把静默连接当死连接掐掉。 */
const HEARTBEAT_MS = 15_000;

/** 当前运行状态：回合、待审批、审批方式、模型、用量与版本，重连首屏用。 */
export interface WebState {
	readonly running: boolean;
	readonly approval: { readonly id: number; readonly request: unknown } | undefined;
	readonly approvalMode: string;
	readonly model: { readonly provider: string; readonly model: string; readonly name: string };
	readonly version: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly effort: string;
	readonly planMode: boolean;
	readonly contextWindow: number | undefined;
	readonly contextTokens: number | undefined;
	/** 会话累计用量;金额缺省说明有请求没配单价 */
	readonly usage: {
		readonly requests: number;
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
		readonly cost: number | undefined;
	};
	/** 会话活动统计;耗时没记到的请求不进累计 */
	readonly activity: {
		readonly turns: number;
		readonly steps: number;
		readonly llmMs: number;
		readonly toolMs: number;
		readonly ttftMs: number;
		readonly ttftCount: number;
		readonly decodeTokens: number;
		readonly decodeMs: number;
	};
}

/** 传输层对装配层的全部要求;每一条都能用假实现独立测试。 */
export interface WebServerDeps {
	/** 当前运行状态:回合、待审批、审批方式、当前模型与应用版本,重连首屏用 */
	snapshot(): WebState;
	/** 会话全量:浏览器首屏重放用 */
		session(): {
			readonly id: string;
			readonly cwd: string;
			readonly workspacePath?: string | null;
			readonly entries: readonly unknown[];
		};
	/** 本工作区的会话清单,按更新时间从新到旧 */
	sessions(): readonly {
		readonly id: string;
		readonly title: string | undefined;
		readonly updatedAt: string;
		readonly cwd?: string;
		readonly workspacePath?: string | null;
	}[];
	/** 已登记空间及显示名 */
	workspaces?(): readonly { readonly path: string; readonly name: string }[];
	/** 删除项目：连同其名下活动与归档会话一起永久删除，返回实际删除的会话数；回合进行中不动任何东西，返回 0 */
	deleteWorkspace(path: string): number;
	/** 切换到既有会话;回合进行中返回 false */
	switchSession(id: string): boolean;
	/** 开一个新会话;null 表示不绑定项目 */
	newSession(workspacePath: string | null): boolean;
	/** 已归档的会话清单 */
		archivedSessions(): readonly {
			readonly id: string;
			readonly title: string | undefined;
			readonly updatedAt: string;
			readonly cwd?: string;
			readonly workspacePath?: string | null;
		}[];
	/** 批量删除会话,返回实际删除的个数;当前会话由装配层跳过 */
	deleteSessions(ids: readonly string[]): number;
	/** 批量归档会话,返回实际归档的个数;当前会话由装配层跳过 */
	archiveSessions(ids: readonly string[]): number;
	/** 批量恢复归档,返回实际恢复的个数 */
	restoreSessions(ids: readonly string[]): number;
	/** 发现的技能清单(技能库面板) */
	skills(): readonly SettingsSkill[];
	/** 已装载的插件清单(插件市场面板) */
	plugins(): readonly { readonly name: string; readonly kind: string; readonly disabled: boolean }[];
	/** 某个插件最近的运行日志;没有日志时返回空表 */
	pluginLogs(name: string, limit: number): readonly PluginLogLine[];
	/** 设置页快照 */
	settings(): SettingsSnapshot;
	/** 应用可热更新的设置;返回错误说明时前端直接展示 */
	applySettings(update: SettingsUpdate): { readonly ok: boolean; readonly error?: string };
	/** 个性化指令原文;超大或不可读时抛错,由传输层回 500 */
	personalization(): {
		readonly path: string;
		readonly text: string;
		readonly bytes: number;
		readonly maxBytes: number;
	};
	/** 写回个性化指令;超过预算或写入失败时返回错误说明 */
	savePersonalization(text: string): { readonly ok: boolean; readonly error?: string };
	/** 安装一个技能压缩包;压缩包内需包含一个 SKILL.md */
	uploadSkill(archive: Uint8Array): { readonly ok: boolean; readonly error?: string };
	/** 读取一个可编辑技能的 description 与正文;只读技能返回错误说明 */
	skillContent(path: string): {
		readonly ok: boolean;
		readonly skill?: {
			readonly name: string;
			readonly description: string;
			readonly content: string;
		};
		readonly error?: string;
	};
	/** 更新一个用户技能;名称不可改 */
	updateSkill(body: Record<string, unknown>): { readonly ok: boolean; readonly error?: string };
	/** 删除一个用户技能 */
	deleteSkill(body: Record<string, unknown>): { readonly ok: boolean; readonly error?: string };
	/** 新增 MCP server 并热接入;写盘或重载配置失败时返回错误说明 */
	addMcpServer(body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly error?: string }>;
	/** 读取一个 MCP server 的完整配置;编辑表单预填用 */
	mcpServerDetail(name: string): McpServerDraft | undefined;
	/** 编辑 MCP server;写盘或运行期替换失败时返回错误说明 */
	updateMcpServer(body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly error?: string }>;
	/** 删除 MCP server;写盘或运行期移除失败时返回错误说明 */
	deleteMcpServer(body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly error?: string }>;
	/** 重连一个 MCP server;返回给界面显示的结果说明 */
	reconnectMcpServer(body: Record<string, unknown>): Promise<{
		readonly ok: boolean;
		readonly error?: string;
		readonly message?: string;
	}>;
	/** 本机提供方清单;API Key 只返回是否已保存 */
	providers(): readonly ProviderView[];
	/** 用设置表单里的当前值试发一次最小请求;不写盘、不占用会话 */
	testProvider(body: Record<string, unknown>): Promise<{
		readonly ok: boolean;
		readonly ms?: number;
		readonly model?: string;
		readonly text?: string;
		readonly error?: string;
	}>;
	/** 新增或更新提供方;写盘后重载当前模型选择 */
	saveProvider(body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly error?: string }>;
	/** 删除提供方;当前正在使用的那一个由装配层拒绝 */
	deleteProvider(body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly error?: string }>;
	/** 读取工作区目录的一层条目 */
	fileTree(path: string): FileTree;
	/** 读取一个文本文件 */
	fileRead(path: string): FileContent;
	/** 按路径搜索文件 */
	fileSearch(query: string, limit: number): readonly FileSearchHit[];
	/** 只读 git 状态;不在仓库里时返回 null */
	gitStatus(): GitStatus | null;
	/** 单文件 diff;失败时返回 null */
	gitDiff(path: string, staged: boolean): string | null;
	/** 提交一句话;回合进行中返回 false,传输层据此回 409 */
	submit(text: string): boolean;
	abort(): void;
	/** 立即压缩上下文;没有压缩器或正在跑回合时返回 false */
	compact(): boolean;
	approval: {
		resolve(id: number, answer: string): void;
	};
	/** 可选的全部模型与当前选择;切换只在空闲时生效 */
	models(): readonly { readonly provider: string; readonly model: string; readonly name: string }[];
	setModel(provider: string, model: string): boolean;
	/** 审批方式热切换;非法取值返回 false */
	setApprovalMode(mode: string): boolean;
	/** Plan 模式热切换;只影响本进程 */
	setPlanMode(enabled: boolean): void;
	/** 订阅推送事件;返回退订函数。每个 SSE 连接订一份。 */
	subscribe(listener: (event: WebEvent) => void): () => void;
	/** 界面构建产物目录;未构建时为空,首页给出构建指引 */
	readonly staticRoot: string | undefined;
}

export interface WebServerOptions {
	/** 回环令牌:全部 /api 请求必须携带(请求头或查询参数) */
	readonly token: string;
	/** 监听端口;0 表示让系统挑一个空闲端口(测试用) */
	readonly port: number;
	/** 心跳间隔;测试传小值验证保活帧,省略用默认值 */
	readonly heartbeatMs?: number;
}

export interface RunningWebServer {
	readonly port: number;
	close(): Promise<void>;
}

/** 允许出现在 Host / Origin 里的主机名;服务只面向本机浏览器。 */
const TRUSTED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Host 头的主机名部分;IPv6 带方括号,不能按冒号切。 */
function hostnameOf(hostHeader: string): string {
	const start = hostHeader.indexOf("[");
	if (start >= 0) return hostHeader.slice(start, hostHeader.indexOf("]") + 1);
	return hostHeader.split(":")[0].toLowerCase();
}

/** DNS rebinding 防线:Host 必须是回环主机名,别人把域名指到 127.0.0.1 也进不来。 */
function isTrustedHost(hostHeader: string | undefined): boolean {
	return hostHeader !== undefined && TRUSTED_HOSTNAMES.has(hostnameOf(hostHeader));
}

/**
 * CSRF 防线:带 Origin 的请求(浏览器跨站表单、fetch)必须来自回环主机。
 * 没有 Origin 的请求(curl、同源 GET)不在此判,由令牌把关。
 */
function isTrustedOrigin(origin: string | undefined): boolean {
	if (origin === undefined) return true;
	try {
		return TRUSTED_HOSTNAMES.has(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/** 令牌比对:长度一致才进等时比较,避免逐字节早退泄露前缀。 */
function tokenMatches(provided: string, expected: string): boolean {
	const left = Buffer.from(provided);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 常见静态资源的类型表;浏览器按它决定怎么渲染。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".map": "application/json; charset=utf-8",
};

const UNBUILT_PAGE = `<!doctype html><meta charset="utf-8"><title>Reins</title>
<p style="font-family: system-ui; padding: 2rem">
界面尚未构建:在仓库根目录运行 <code>npm run build:ui</code>,然后重启 serve。
</p>`;

/** 解析路径并确认它没有逃出根目录;逃出即拒绝,不给试探盘符的机会。 */
function safeStaticPath(root: string, urlPath: string): string | undefined {
	let relative: string;
	try {
		relative = decodeURIComponent(urlPath);
	} catch {
		return undefined;
	}
	const target = resolve(root, join(".", relative));
	if (target !== root && !target.startsWith(root + sep)) return undefined;
	return target;
}

/** 读取静态文件;读不到返回 undefined,由调用方决定回落到 index 还是提示页。 */
async function readStatic(root: string, urlPath: string): Promise<{ body: Buffer; type: string } | undefined> {
	const target = safeStaticPath(root, urlPath);
	if (target === undefined) return undefined;
	try {
		const body = await readFile(target);
		const type = CONTENT_TYPES[target.slice(target.lastIndexOf("."))] ?? "application/octet-stream";
		return { body, type };
	} catch {
		return undefined;
	}
}

/** 把一条 SSE 帧写给浏览器;连接已断时静默放弃,由 close 事件负责清理。 */
function writeFrame(res: ServerResponse, payload: string): void {
	if (!res.writableEnded) res.write(payload);
}

/** 建立 SSE 连接:订阅推送、按心跳保活,断开时全部退订。 */
function streamEvents(req: IncomingMessage, res: ServerResponse, deps: WebServerDeps, heartbeatMs: number | undefined): void {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	res.write("retry: 3000\n\n");
	const unsubscribe = deps.subscribe((event) => {
		writeFrame(res, `data: ${JSON.stringify(event)}\n\n`);
	});
	const heartbeat = setInterval(() => writeFrame(res, ": ping\n\n"), heartbeatMs ?? HEARTBEAT_MS);
	res.on("close", () => {
		clearInterval(heartbeat);
		unsubscribe();
	});
	req.on("error", () => {});
}

/** 读请求体并按 JSON 解析;超限或解析失败返回 undefined。 */
/** 读原始请求体;超过上限时返回 undefined,由调用方回 413。 */
async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > maxBytes) return undefined;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** 组装本地服务。返回 start 以便调用方选端口后再打印访问地址。 */
export function createWebServer(deps: WebServerDeps, options: WebServerOptions): { start(): Promise<RunningWebServer> } {
	const server: Server = createServer((req, res) => {
		void handle(req, res).catch(() => sendJson(res, 500, { error: "internal error" }));
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		if (!isTrustedHost(req.headers.host)) {
			sendJson(res, 403, { error: "untrusted host" });
			return;
		}

		// 静态资源不带 /api 前缀,也不需要令牌:构建产物本身不含任何秘密
		if (!path.startsWith("/api/") && path !== "/api") {
			await servePage(res, url.pathname, deps.staticRoot);
			return;
		}

		const provided = req.headers["x-reins-token"] ?? url.searchParams.get("token") ?? "";
		if (!tokenMatches(String(provided), options.token)) {
			sendJson(res, 401, { error: "missing or invalid token" });
			return;
		}

		if (req.method === "GET" && path === "/api/events") {
			streamEvents(req, res, deps, options.heartbeatMs);
			return;
		}
		if (req.method === "GET" && path === "/api/state") {
			sendJson(res, 200, deps.snapshot());
			return;
		}
		if (req.method === "GET" && path === "/api/session") {
			sendJson(res, 200, deps.session());
			return;
		}
			if (req.method === "GET" && path === "/api/sessions") {
				sendJson(res, 200, deps.sessions());
				return;
			}
			if (req.method === "GET" && path === "/api/workspaces") {
				sendJson(res, 200, deps.workspaces?.() ?? []);
				return;
			}
			if (req.method === "GET" && path === "/api/sessions/archived") {
				sendJson(res, 200, deps.archivedSessions());
				return;
			}
		if (req.method === "POST" && path === "/api/sessions/delete") {
			const body = await readJsonBody(req);
			const ids = body?.["ids"];
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
				sendJson(res, 400, { error: "ids must be an array of strings" });
				return;
			}
			sendJson(res, 200, { deleted: deps.deleteSessions(ids as string[]) });
			return;
		}
		if (req.method === "POST" && path === "/api/sessions/archive") {
			const body = await readJsonBody(req);
			const ids = body?.["ids"];
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
				sendJson(res, 400, { error: "ids must be an array of strings" });
				return;
			}
			sendJson(res, 200, { archived: deps.archiveSessions(ids as string[]) });
			return;
		}
		if (req.method === "POST" && path === "/api/sessions/restore") {
			const body = await readJsonBody(req);
			const ids = body?.["ids"];
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
				sendJson(res, 400, { error: "ids must be an array of strings" });
				return;
			}
			sendJson(res, 200, { restored: deps.restoreSessions(ids as string[]) });
			return;
		}
		// 删除项目是内核动作：任务归属、当前会话的让位都只有内核判得准，壳与界面都不参与
		if (req.method === "POST" && path === "/api/workspaces/delete") {
			const body = await readJsonBody(req);
			const target = body?.["path"];
			if (typeof target !== "string" || target.length === 0) {
				sendJson(res, 400, { error: "path must be a non-empty string" });
				return;
			}
			sendJson(res, 200, { deleted: deps.deleteWorkspace(target) });
			return;
		}
		if (req.method === "GET" && path === "/api/skills") {
			sendJson(res, 200, deps.skills());
			return;
		}
		if (req.method === "GET" && path === "/api/skills/content") {
			const skillPath = url.searchParams.get("path");
			if (skillPath === null || skillPath.length === 0) {
				sendJson(res, 400, { error: "path is required" });
				return;
			}
			const result = deps.skillContent(skillPath);
			if (!result.ok || result.skill === undefined) {
				sendJson(res, 400, { error: result.error ?? "无法读取技能" });
				return;
			}
			sendJson(res, 200, result.skill);
			return;
		}
		if (req.method === "GET" && path === "/api/mcp-servers/detail") {
			const name = url.searchParams.get("name");
			if (name === null || name.length === 0) {
				sendJson(res, 400, { error: "name is required" });
				return;
			}
			const detail = deps.mcpServerDetail(name);
			if (detail === undefined) {
				sendJson(res, 404, { error: "MCP server not found" });
				return;
			}
			sendJson(res, 200, detail);
			return;
		}
		if (req.method === "POST" && path === "/api/mcp-servers") {
			const body = await readJsonBody(req);
			const result = await deps.addMcpServer(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法添加 MCP 服务器" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && path === "/api/plugins") {
			sendJson(res, 200, deps.plugins());
			return;
		}
		if (req.method === "GET" && path === "/api/plugins/logs") {
			const name = url.searchParams.get("name");
			if (name === null || name.length === 0) {
				sendJson(res, 400, { error: "name is required" });
				return;
			}
			const rawLimit = url.searchParams.get("limit");
			const limit = rawLimit === null ? PLUGIN_LOG_LIMIT : Number.parseInt(rawLimit, 10);
			if (!Number.isFinite(limit) || limit <= 0) {
				sendJson(res, 400, { error: "limit must be a positive integer" });
				return;
			}
			sendJson(res, 200, { lines: deps.pluginLogs(name, limit) });
			return;
		}
		if (req.method === "GET" && path === "/api/models") {
			sendJson(res, 200, deps.models());
			return;
		}
		if (req.method === "GET" && path === "/api/providers") {
			sendJson(res, 200, deps.providers());
			return;
		}
		if (req.method === "POST" && path === "/api/providers") {
			const body = await readJsonBody(req);
			const result = await deps.saveProvider(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法保存提供方" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && path === "/api/providers/delete") {
			const body = await readJsonBody(req);
			const result = await deps.deleteProvider(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法删除提供方" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && path === "/api/providers/test") {
			// 上游失败不是请求本身失败：始终 200，由界面读 ok 与 error 区分结果
			const body = await readJsonBody(req);
			sendJson(res, 200, await deps.testProvider(body ?? {}));
			return;
		}
		if (req.method === "GET" && path === "/api/settings") {
			sendJson(res, 200, deps.settings());
			return;
		}
		if (req.method === "GET" && path === "/api/personalization") {
			try {
				sendJson(res, 200, deps.personalization());
			} catch (error) {
				sendJson(res, 500, { error: errorMessage(error) });
			}
			return;
		}
		if (req.method === "PUT" && path === "/api/personalization") {
			const body = await readJsonBody(req);
			const text = body?.["text"];
			if (typeof text !== "string") {
				sendJson(res, 400, { error: "缺少个性化指令内容" });
				return;
			}
			const result = deps.savePersonalization(text);
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法保存个性化指令" });
				return;
			}
			sendJson(res, 200, deps.personalization());
			return;
		}
		if (req.method === "GET" && path === "/api/files/tree") {
			try {
				sendJson(res, 200, deps.fileTree(url.searchParams.get("path") ?? ""));
			} catch (error) {
				sendJson(res, 400, { error: errorMessage(error) });
			}
			return;
		}
		if (req.method === "GET" && path === "/api/files/read") {
			const file = url.searchParams.get("path");
			if (file === null || file.length === 0) {
				sendJson(res, 400, { error: "path is required" });
				return;
			}
			try {
				sendJson(res, 200, deps.fileRead(file));
			} catch (error) {
				sendJson(res, 400, { error: errorMessage(error) });
			}
			return;
		}
		if (req.method === "GET" && path === "/api/files/search") {
			const query = url.searchParams.get("q") ?? "";
			const limit = Number(url.searchParams.get("limit") ?? "20");
			sendJson(res, 200, deps.fileSearch(query, Number.isFinite(limit) ? limit : 20));
			return;
		}
		if (req.method === "GET" && path === "/api/git/status") {
			sendJson(res, 200, deps.gitStatus());
			return;
		}
		if (req.method === "GET" && path === "/api/git/diff") {
			const file = url.searchParams.get("path");
			if (file === null || file.length === 0) {
				sendJson(res, 400, { error: "path is required" });
				return;
			}
			sendJson(res, 200, { diff: deps.gitDiff(file, url.searchParams.get("staged") === "1") });
			return;
		}
		if (req.method === "POST") {
			if (!isTrustedOrigin(req.headers.origin)) {
				sendJson(res, 403, { error: "untrusted origin" });
				return;
			}
			await handlePost(req, res, path, deps);
			return;
		}
		sendJson(res, 405, { error: "method not allowed" });
	}

	async function handlePost(req: IncomingMessage, res: ServerResponse, path: string, deps: WebServerDeps): Promise<void> {
		if (path === "/api/message") {
			const body = await readJsonBody(req);
			const text = body?.["text"];
			if (typeof text !== "string" || text.length === 0) {
				sendJson(res, 400, { error: "text is required" });
				return;
			}
			if (!deps.submit(text)) {
				sendJson(res, 409, { error: "a turn is already running" });
				return;
			}
			sendJson(res, 202, { ok: true });
			return;
		}
		if (path === "/api/abort") {
			deps.abort();
			sendJson(res, 202, { ok: true });
			return;
		}
		if (path === "/api/approval") {
			const body = await readJsonBody(req);
			const id = body?.["id"];
			const answer = body?.["answer"];
			if (typeof id !== "number" || typeof answer !== "string") {
				sendJson(res, 400, { error: "id and answer are required" });
				return;
			}
			// 结论的合法性由审批桥把关:无效的请求会被它静默丢弃,传输层只负责转交
			deps.approval.resolve(id, answer);
			sendJson(res, 202, { ok: true });
			return;
		}
		if (path === "/api/session/switch") {
			const body = await readJsonBody(req);
			const id = body?.["id"];
			if (typeof id !== "string" || id.length === 0) {
				sendJson(res, 400, { error: "id is required" });
				return;
			}
			if (!deps.switchSession(id)) {
				sendJson(res, 409, { error: "cannot switch now" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/session/new") {
			const body = await readJsonBody(req);
			const workspacePath = body?.["workspacePath"];
			if (workspacePath !== undefined && workspacePath !== null && typeof workspacePath !== "string") {
				sendJson(res, 400, { error: "workspacePath must be a string or null" });
				return;
			}
			if (!deps.newSession(typeof workspacePath === "string" ? workspacePath : null)) {
				sendJson(res, 409, { error: "cannot switch now" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/model") {
			const body = await readJsonBody(req);
			const provider = body?.["provider"];
			const model = body?.["model"];
			if (typeof provider !== "string" || typeof model !== "string") {
				sendJson(res, 400, { error: "provider and model are required" });
				return;
			}
			if (!deps.setModel(provider, model)) {
				sendJson(res, 400, { error: "unknown provider or model" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/approval-mode") {
			const body = await readJsonBody(req);
			const mode = body?.["mode"];
			if (typeof mode !== "string") {
				sendJson(res, 400, { error: "mode is required" });
				return;
			}
			if (!deps.setApprovalMode(mode)) {
				sendJson(res, 400, { error: "unknown approval mode" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/settings") {
			const body = await readJsonBody(req);
			const parsed = parseSettingsUpdate(body ?? {});
			if (!parsed.ok || parsed.update === undefined) {
				sendJson(res, 400, { error: parsed.error ?? "invalid settings" });
				return;
			}
			const result = deps.applySettings(parsed.update);
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "cannot apply settings" });
				return;
			}
			sendJson(res, 200, deps.settings());
			return;
		}
		if (path === "/api/skills/upload") {
			const archive = await readBinaryBody(req, MAX_SKILL_ARCHIVE_BYTES);
			if (archive === undefined) {
				sendJson(res, 413, { error: `压缩包不能超过 ${MAX_SKILL_ARCHIVE_BYTES / 1024 / 1024} MB` });
				return;
			}
			if (archive.length === 0) {
				sendJson(res, 400, { error: "请选择 zip 压缩包" });
				return;
			}
			const result = deps.uploadSkill(archive);
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法上传技能" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/skills/update") {
			const body = await readJsonBody(req);
			const result = deps.updateSkill(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法更新技能" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/skills/delete") {
			const body = await readJsonBody(req);
			const result = deps.deleteSkill(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法删除技能" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/mcp-servers/update") {
			const body = await readJsonBody(req);
			const result = await deps.updateMcpServer(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法更新 MCP 服务器" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/mcp-servers/delete") {
			const body = await readJsonBody(req);
			const result = await deps.deleteMcpServer(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法删除 MCP 服务器" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/mcp-servers/reconnect") {
			const body = await readJsonBody(req);
			const result = await deps.reconnectMcpServer(body ?? {});
			if (!result.ok) {
				sendJson(res, 400, { error: result.error ?? "无法重连 MCP 服务器" });
				return;
			}
			sendJson(res, 200, { ok: true, message: result.message ?? "" });
			return;
		}
		if (path === "/api/plan-mode") {
			const body = await readJsonBody(req);
			const enabled = body?.["enabled"];
			if (typeof enabled !== "boolean") {
				sendJson(res, 400, { error: "enabled is required" });
				return;
			}
			deps.setPlanMode(enabled);
			sendJson(res, 200, { ok: true });
			return;
		}
		if (path === "/api/compact") {
			if (!deps.compact()) {
				sendJson(res, 409, { error: "cannot compact now" });
				return;
			}
			sendJson(res, 202, { ok: true });
			return;
		}
		sendJson(res, 404, { error: "not found" });
	}

	async function servePage(res: ServerResponse, urlPath: string, root: string | undefined): Promise<void> {
		if (root !== undefined) {
			const file = await readStatic(root, urlPath);
			if (file !== undefined) {
				res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
				res.end(file.body);
				return;
			}
			// SPA 回落:未知路径交给 index,让前端路由接管
			const index = await readStatic(root, "/index.html");
			if (index !== undefined) {
				res.writeHead(200, { "content-type": index.type, "cache-control": "no-cache" });
				res.end(index.body);
				return;
			}
		}
		res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
		res.end(UNBUILT_PAGE);
	}

	return {
		start(): Promise<RunningWebServer> {
			return new Promise((resolveStart, rejectStart) => {
				// 端口被占用是最现实的启动失败:在这里拒绝,而不是让 start 永远悬着
				server.once("error", rejectStart);
				server.listen(options.port, "127.0.0.1", () => {
					const address = server.address();
					const port = typeof address === "object" && address !== null ? address.port : options.port;
					resolveStart({
						port,
						close: () =>
							new Promise<void>((resolveClose) => {
								server.close(() => resolveClose());
							}),
					});
				});
			});
		},
	};
}
