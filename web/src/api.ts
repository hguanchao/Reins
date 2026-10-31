/**
 * 与本地 serve 的通信客户端。
 *
 * 令牌从地址栏带入并存进 localStorage:刷新后地址栏没有 token 也能继续用;换端口或换
 * 会话时清掉重登即可。事件流用 EventSource,浏览器自己负责断线重连。
 */

import type { ApprovalAnswer, ApprovalRequest, SessionEntry, WebEvent } from "./types";

const FROM_URL = new URLSearchParams(window.location.search).get("token");
if (FROM_URL !== null) localStorage.setItem("reins-token", FROM_URL);
const token = FROM_URL ?? localStorage.getItem("reins-token") ?? "";

const HEADERS = { "x-reins-token": token } as const;

async function request(path: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(path, { ...init, headers: { ...HEADERS, ...init?.headers } });
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const message = (body as { error?: unknown } | undefined)?.["error"];
		throw new Error(typeof message === "string" ? message : response.statusText);
	}
	return body;
}

export interface ServeState {
	running: boolean;
	approval: { id: number; request: ApprovalRequest } | undefined;
}

export const api = {
	async state(): Promise<ServeState> {
		return (await request("/api/state")) as ServeState;
	},
	async session(): Promise<{ id: string; cwd: string; entries: readonly SessionEntry[] }> {
		return (await request("/api/session")) as { id: string; cwd: string; entries: readonly SessionEntry[] };
	},
	async send(text: string): Promise<void> {
		await request("/api/message", { method: "POST", body: JSON.stringify({ text }) });
	},
	async abort(): Promise<void> {
		await request("/api/abort", { method: "POST" });
	},
	async approve(id: number, answer: ApprovalAnswer): Promise<void> {
		await request("/api/approval", { method: "POST", body: JSON.stringify({ id, answer }) });
	},
};

/** 打开事件流;返回关闭函数。连接状态变化经 onStatus 上报,界面据此显示断线提示。 */
export function openEventStream(onEvent: (event: WebEvent) => void, onStatus: (connected: boolean) => void): () => void {
	const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
	source.onopen = () => onStatus(true);
	source.onerror = () => onStatus(false);
	source.onmessage = (message) => {
		try {
			// 断言成立的前提是消费方只用判别分支读字段;未知事件落在 default,不碰任何属性
			onEvent(JSON.parse(message.data) as WebEvent);
		} catch {
			// 单帧损坏只丢这一帧,不拖垮整个事件流
		}
	};
	return () => source.close();
}
