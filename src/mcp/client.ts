import type { JsonSchema } from "#src/tools/schema.ts";
import type { JsonRpcMessage, McpTransport } from "#src/mcp/transport.ts";

/**
 * MCP 客户端。
 *
 * 一件事要在这里做完：把 JSON-RPC 的一问一答对上号。传输层只管搬报文，谁等哪条回音由这里
 * 记账——远端可能乱序回，也可能在回音之前先推几条通知过来。
 *
 * 超时分两档。控制请求（握手、列工具）只是来回一趟，卡住就说明连接有问题，用固定的短超时；
 * 工具调用是真的在干活，可能跑很久，用配置里给的时限。
 */

/** 控制请求的超时。 */
export const CONTROL_TIMEOUT_MS = 15_000;

/** 工具调用没配置时限时的取值。 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

const PROTOCOL_VERSION = "2025-06-18";

export interface McpToolInfo {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
}

export interface McpCallResult {
	readonly content: string;
	readonly isError: boolean;
}

export interface McpClientOptions {
	readonly transport: McpTransport;
	readonly clientName: string;
	readonly version: string;
	/** 控制请求（握手、列工具）的超时 */
	readonly controlTimeoutMs: number;
	readonly callTimeoutMs: number;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class McpClient {
	readonly #options: McpClientOptions;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#closed = false;

	constructor(options: McpClientOptions) {
		this.#options = options;
	}

	/** 握手。 */
	async connect(): Promise<void> {
		// 先开始收：握手的第一条回音也要有人接
		void this.#pump();

		// 服务端回给它的协议版本。本程序只用到最稳定的那三个方法，因此按它给的版本继续，
		// 不因为版本号不同就断开
		await this.#request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: this.#options.clientName, version: this.#options.version },
			},
			this.#options.controlTimeoutMs,
		);
		await this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	async listTools(): Promise<readonly McpToolInfo[]> {
		const result = await this.#request("tools/list", {}, this.#options.controlTimeoutMs);
		const tools = isRecord(result) ? result["tools"] : undefined;
		if (!Array.isArray(tools)) return [];

		const infos: McpToolInfo[] = [];
		for (const item of tools) {
			if (!isRecord(item) || typeof item["name"] !== "string") continue;
			infos.push({
				name: item["name"],
				description: typeof item["description"] === "string" ? item["description"] : "",
				inputSchema: readInputSchema(item["inputSchema"]),
			});
		}
		return infos;
	}

	/**
	 * 健康检查。
	 *
	 * MCP 定义了 ping，但不是每个 server 都实现；方法不存在时退回列一次工具，同样能证明
	 * 连接还在。两种都失败才算连接不可用。
	 */
	async ping(): Promise<void> {
		try {
			await this.#request("ping", {}, this.#options.controlTimeoutMs);
		} catch {
			await this.listTools();
		}
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<McpCallResult> {
		const result = await this.#request(
			"tools/call",
			{ name, arguments: args },
			this.#options.callTimeoutMs,
			signal,
		);
		return readCallResult(result);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#options.transport.close();
		this.#failAll(new Error("Connection is closed"));
	}

	/** 后台把收到的报文分派出去：回音交给等它的人，别的都丢掉。 */
	async #pump(): Promise<void> {
		try {
			for await (const message of this.#options.transport.receive()) this.#dispatch(message);
		} catch {
			// 传输层自己会把断线原因报给上层；这里只负责把还等着的请求叫醒
		}
		this.#failAll(new Error("Connection to the server was lost"));
	}

	#dispatch(message: JsonRpcMessage): void {
		const id = message["id"];

		if (typeof message["method"] === "string") {
			// 通知没有 id，本程序不处理
			if (id === undefined) return;
			// 服务端反过来请求本程序（采样、列根目录之类）。本程序不提供这些能力，明确回一句
			// 「不支持」，免得对方一直等
			void this.#send({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "This request is not supported by this client" },
			}).catch(() => undefined);
			return;
		}

		if (typeof id !== "number") return;
		const pending = this.#pending.get(id);
		if (pending === undefined) return;
		this.#pending.delete(id);

		const error = message["error"];
		if (error !== undefined) {
			pending.reject(new Error(describeRpcError(error)));
			return;
		}
		pending.resolve(message["result"]);
	}

	#request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		const id = this.#nextId;
		this.#nextId += 1;

		return new Promise<unknown>((resolve, reject) => {
			const settle = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(id);
			};
			const timer = setTimeout(() => {
				settle();
				reject(new Error(`${method} did not respond within ${timeoutMs}ms`));
			}, timeoutMs);
			const onAbort = (): void => {
				settle();
				// 告诉服务端别再算了：不打招呼就放手，它会白干一场，占着的东西也不会释放
				void this.#send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, reason: "aborted" },
				}).catch(() => undefined);
				reject(new Error("aborted"));
			};

			this.#pending.set(id, {
				resolve: (value) => {
					settle();
					resolve(value);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			});

			if (signal?.aborted === true) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });

			void this.#send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
				settle();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async #send(message: JsonRpcMessage): Promise<void> {
		if (this.#closed) throw new Error("Connection is closed");
		await this.#options.transport.send(message);
	}

	#failAll(error: Error): void {
		const waiting = [...this.#pending.values()];
		this.#pending.clear();
		for (const pending of waiting) pending.reject(error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 参数模式原样交给模型。
 *
 * 远端可能用到我们那套子集之外的写法（anyOf、$ref 之类）。校验器只认自己认识的部分，不认识
 * 的构造整段放过——这里宁可少校验，也不能把合法的调用判成参数错：真正的参数约束由服务端
 * 自己把关。服务端没给模式时按「不收任何参数的对象」处理。
 */
function readInputSchema(raw: unknown): JsonSchema {
	if (isRecord(raw)) return raw as JsonSchema;
	return { type: "object", properties: {} };
}

function readCallResult(result: unknown): McpCallResult {
	if (!isRecord(result)) return { content: "The server returned no result.", isError: true };

	const isError = result["isError"] === true;
	const blocks = Array.isArray(result["content"]) ? result["content"] : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) continue;
		if (block["type"] === "text" && typeof block["text"] === "string") {
			parts.push(block["text"]);
			continue;
		}
		// 图片、资源这类块显示不出来，但要说一声它们存在，否则模型会以为服务端只回了这些文字
		const kind = typeof block["type"] === "string" ? block["type"] : "unknown";
		parts.push(`[${kind} content is not shown here]`);
	}

	if (parts.length === 0) {
		parts.push(isError ? "The server reported a failure without a reason." : "The server returned no content.");
	}
	return { content: parts.join("\n\n"), isError };
}

function describeRpcError(error: unknown): string {
	if (!isRecord(error)) return `The server returned an error: ${JSON.stringify(error)}`;
	const message = typeof error["message"] === "string" ? error["message"] : "no reason given";
	const code = typeof error["code"] === "number" ? `（${error["code"]}）` : "";
	return `${message}${code}`;
}
