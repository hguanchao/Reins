import { spawn, type ChildProcess } from "node:child_process";
import { describeError } from "#src/shared/describe-error.ts";
import { createParser } from "eventsource-parser";

/**
 * MCP 的传输接缝。
 *
 * 三种接入形态（本地进程、远程端点、旧式 SSE）在报文这一层没有区别，都是 JSON-RPC；
 * 差别只在「报文从哪来、往哪去」。所以这里只留两个动作：发一条、收一串。
 *
 * 收的那一串由各实现往同一个队列里塞，调用方只面对一个流，不必知道底下是管道还是网络。
 */

export type JsonRpcMessage = Record<string, unknown>;

export interface McpTransport {
	/** 发一条报文。发不出去就抛错，由调用方决定怎么记。 */
	send(message: JsonRpcMessage): Promise<void>;
	/** 收到的报文，按到达顺序。迭代结束表示连接断了。 */
	receive(): AsyncIterable<JsonRpcMessage>;
	close(): void;
}

/** 把「会陆续到达的报文」变成一个可迭代的流：先到的排队，后来的直接交给等着的人。 */
class MessageQueue {
	readonly #items: JsonRpcMessage[] = [];
	readonly #waiters: ((result: IteratorResult<JsonRpcMessage>) => void)[] = [];
	#closed = false;

	push(message: JsonRpcMessage): void {
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) {
			waiter({ value: message, done: false });
			return;
		}
		this.#items.push(message);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<JsonRpcMessage> {
		return {
			next: (): Promise<IteratorResult<JsonRpcMessage>> => {
				const item = this.#items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.#closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.#waiters.push(resolve));
			},
		};
	}
}

/** 报文必须是一个 JSON 对象。数组与字面量都不是合法的 JSON-RPC 报文。 */
function parseMessage(text: string): JsonRpcMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return parsed as JsonRpcMessage;
}

export interface StdioTransportOptions {
	readonly command: string;
	readonly args: readonly string[];
	/** 子进程的工作目录 */
	readonly cwd: string;
	/** 叠加在宿主环境之上的变量；server 的启动参数常要靠它拿到凭据 */
	readonly env?: Readonly<Record<string, string>>;
	/** 连接断了（起不来、进程退出）时告知原因 */
	readonly onClose: (reason: string) => void;
}

/**
 * 本地进程。
 *
 * 子进程要 unref：它只是提供能力，不是本程序要做的事，不该把父进程的事件循环拖到它退出
 * 为止。同时挂一个退出钩子把它带走——留下一个孤儿进程占着端口或文件，下次启动就更难查。
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
	const queue = new MessageQueue();
	const child = spawn(options.command, [...options.args], {
		cwd: options.cwd,
		// 宿主环境先铺，server 自己声明的变量优先：它要的是「覆盖」而不是「替换」，
		// 换掉整份环境会让 server 找不到 PATH 上的解释器
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	const stdin = child.stdin;
	const stdout = child.stdout;
	const stderr = child.stderr;
	if (stdin === null || stdout === null || stderr === null) {
		throw new Error(`Cannot set up pipes for ${options.command}`);
	}

	let buffer = "";
	stdout.setEncoding("utf8");
	stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const index = buffer.indexOf("\n");
			if (index === -1) break;
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.length === 0) continue;
			// 协议要求日志走标准错误。服务端往标准输出打了一行别的东西时跳过它而不是断开：
			// 一句无关的打印不该让整条连接作废
			const message = parseMessage(line);
			if (message !== undefined) queue.push(message);
		}
	});

	// 服务端的日志按协议写在标准错误里，但本程序没有地方显示它；读掉即可，免得管道填满后卡住对方
	stderr.resume();

	// 起不来时 error 与 close 会先后到达。只认第一条：先到的那条才说得清原因，
	// 后到的往往只是一句「进程退出了」加一个看不懂的退出码
	let reported = false;
	const report = (reason: string): void => {
		if (reported) return;
		reported = true;
		queue.close();
		options.onClose(reason);
	};

	child.on("error", (error) => {
		report(`Cannot start ${options.command}: ${error.message}`);
	});
	child.on("close", (code) => {
		report(`${options.command} exited (code ${code ?? "unknown"})`);
	});

	unrefChild(child);
	const onExit = (): void => {
		child.kill();
	};
	process.once("exit", onExit);

	return {
		async send(message) {
			if (stdin.destroyed) throw new Error("Connection is closed");
			await new Promise<void>((resolve, reject) => {
				stdin.write(`${JSON.stringify(message)}\n`, (error) => {
					if (error === null || error === undefined) resolve();
					else reject(error);
				});
			});
		},
		receive: () => queue,
		close() {
			process.removeListener("exit", onExit);
			queue.close();
			try {
				child.kill();
			} catch {
				// pid 还没分配时 kill 会抛 EINVAL；这时进程要么还没起来，要么已经退出，
				// 没有可杀的东西
			}
		},
	};
}

function unrefChild(child: ChildProcess): void {
	child.unref();
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		// 管道在运行期是 Socket，带 unref；类型上它是 Readable 或 Writable
		(stream as { unref?: () => void } | null)?.unref?.();
	}
}

export interface RemoteTransportOptions {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly signal: AbortSignal;
	readonly onClose: (reason: string) => void;
}

/**
 * 远程端点，一问一答。
 *
 * 请求体就是那条报文，响应要么是一整个 JSON，要么是一条事件流（服务端在干活的过程中往流里
 * 推进度）。两种都收在这里，调用方不必区分。
 */
export function createHttpTransport(options: RemoteTransportOptions): McpTransport {
	const queue = new MessageQueue();

	return {
		async send(message) {
			const response = await fetch(options.url, {
				method: "POST",
				headers: requestHeaders(options.headers, "application/json, text/event-stream"),
				body: JSON.stringify(message),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(await describeResponse(response));

			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				await readEventStream(response, (event) => {
					const parsed = parseMessage(event.data);
					if (parsed !== undefined) queue.push(parsed);
				});
				return;
			}

			const text = await response.text();
			// 通知没有响应体，这是正常的
			if (text.trim().length === 0) return;
			const parsed = parseMessage(text);
			if (parsed === undefined) throw new Error("The server sent something that is not a JSON-RPC message");
			queue.push(parsed);
		},
		receive: () => queue,
		close() {
			queue.close();
		},
	};
}

/**
 * 旧式 SSE：先开一条长连接，服务端在第一条事件里给出投递地址，之后请求都发给那个地址，
 * 响应则统一从长连接上回来。
 */
export function createSseTransport(options: RemoteTransportOptions): McpTransport {
	const queue = new MessageQueue();
	let endpoint: string | undefined;

	void (async () => {
		try {
			const response = await fetch(options.url, {
				method: "GET",
				headers: requestHeaders(options.headers, "text/event-stream"),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(await describeResponse(response));

			await readEventStream(response, (event) => {
				if (event.event === "endpoint") {
					endpoint = new URL(event.data, options.url).toString();
					return;
				}
				const parsed = parseMessage(event.data);
				if (parsed !== undefined) queue.push(parsed);
			});
			queue.close();
			options.onClose("The server closed the event stream");
		} catch (error) {
			queue.close();
			options.onClose(describeError(error));
		}
	})();

	return {
		async send(message) {
			if (endpoint === undefined) throw new Error("The server has not given a message endpoint yet");
			const response = await fetch(endpoint, {
				method: "POST",
				headers: requestHeaders(options.headers, "application/json"),
				body: JSON.stringify(message),
				signal: options.signal,
			});
			// 响应从长连接回来，这里的响应体是空的
			if (!response.ok) throw new Error(await describeResponse(response));
		},
		receive: () => queue,
		close() {
			queue.close();
		},
	};
}

function requestHeaders(
	extra: Readonly<Record<string, string>>,
	accept: string,
): Record<string, string> {
	return { "content-type": "application/json", accept, ...extra };
}

async function describeResponse(response: Response): Promise<string> {
	let body = "";
	try {
		body = await response.text();
	} catch {
		body = "";
	}
	const trimmed = body.length > 300 ? `${body.slice(0, 300)}…` : body;
	return `HTTP ${response.status}${trimmed.length > 0 ? ` ${trimmed}` : ""}`;
}

/** 逐条读事件流。切分交给专门的解析器：一条事件可能被拆在多个网络分片里，也可能一个分片里有好几条。 */
async function readEventStream(
	response: Response,
	onEvent: (event: { readonly event: string; readonly data: string }) => void,
): Promise<void> {
	const body = response.body;
	if (body === null) throw new Error("Response has no body");

	const parser = createParser({
		onEvent: (event) => {
			if (event.data.length > 0) onEvent({ event: event.event ?? "", data: event.data });
		},
	});
	const decoder = new TextDecoder("utf-8");
	const reader = body.getReader();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parser.feed(decoder.decode(value, { stream: true }));
	}
	// 收尾：把解码器里可能残留的半个字符与解析器里没有换行结尾的最后一条事件放出来
	parser.feed(decoder.decode());
	parser.reset({ consume: true });
}
