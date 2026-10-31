import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

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

/** 传输层对装配层的全部要求;每一条都能用假实现独立测试。 */
export interface WebServerDeps {
	/** 当前运行状态:回合、待审批、审批方式与当前模型,重连首屏用 */
	snapshot(): {
		running: boolean;
		approval: { readonly id: number; readonly request: unknown } | undefined;
		approvalMode: string;
		model: { readonly provider: string; readonly model: string; readonly name: string };
	};
	/** 会话全量:浏览器首屏重放用 */
	session(): { readonly id: string; readonly cwd: string; readonly entries: readonly unknown[] };
	/** 本工作区的会话清单,按更新时间从新到旧 */
	sessions(): readonly { readonly id: string; readonly title: string | undefined; readonly updatedAt: string }[];
	/** 切换到既有会话;回合进行中返回 false */
	switchSession(id: string): boolean;
	/** 开一个新会话;回合进行中返回 false */
	newSession(): boolean;
	/** 提交一句话;回合进行中返回 false,传输层据此回 409 */
	submit(text: string): boolean;
	abort(): void;
	approval: {
		resolve(id: number, answer: string): void;
	};
	/** 可选的全部模型与当前选择;切换只在空闲时生效 */
	models(): readonly { readonly provider: string; readonly model: string; readonly name: string }[];
	setModel(provider: string, model: string): boolean;
	/** 审批方式热切换;合法取值由装配层把关 */
	setApprovalMode(mode: string): void;
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
		if (req.method === "GET" && path === "/api/models") {
			sendJson(res, 200, deps.models());
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
			if (!deps.newSession()) {
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
			deps.setApprovalMode(mode);
			sendJson(res, 200, { ok: true });
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
