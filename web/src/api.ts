/**
 * 与本地 serve 的通信客户端。
 *
 * 令牌从地址栏带入并存进 localStorage:刷新后地址栏没有 token 也能继续用;换端口或换
 * 会话时清掉重登即可。事件流用 EventSource,浏览器自己负责断线重连。
 */

import type {
	ApprovalAnswer,
	ApprovalMode,
	FileContent,
	FileSearchHit,
	FileTree,
	GitStatus,
	ModelInfo,
	McpServerInput,
	NotifyMode,
	PersonalizationSnapshot,
	PluginInfo,
	PluginLogLine,
	ProviderInput,
	ProviderTestResult,
	ProviderView,
	SessionEntry,
	SessionSummary,
	SettingsSnapshot,
	SkillContent,
	SkillInfo,
	SkillUpdateInput,
	StateInfo,
	ThinkingLevel,
	WorkspaceSummary,
	WebEvent,
} from "./protocol.ts";

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

export type ServeState = StateInfo;

export const api = {
	async state(): Promise<ServeState> {
		return (await request("/api/state")) as ServeState;
	},
	async session(): Promise<{
		id: string;
		cwd: string;
		workspacePath?: string | null;
		entries: readonly SessionEntry[];
	}> {
		return (await request("/api/session")) as {
			id: string;
			cwd: string;
			workspacePath?: string | null;
			entries: readonly SessionEntry[];
		};
	},
	async skills(): Promise<readonly SkillInfo[]> {
		return (await request("/api/skills")) as readonly SkillInfo[];
	},
	async plugins(): Promise<readonly PluginInfo[]> {
		return (await request("/api/plugins")) as readonly PluginInfo[];
	},
	async pluginLogs(name: string, limit = 200): Promise<readonly PluginLogLine[]> {
		const body = (await request(
			`/api/plugins/logs?name=${encodeURIComponent(name)}&limit=${limit}`,
		)) as { lines?: readonly PluginLogLine[] };
		return body.lines ?? [];
	},
	async sessions(): Promise<readonly SessionSummary[]> {
		return (await request("/api/sessions")) as readonly SessionSummary[];
	},
	async workspaces(): Promise<readonly WorkspaceSummary[]> {
		return (await request("/api/workspaces")) as readonly WorkspaceSummary[];
	},
	/** 已从侧栏移除的工作区：设置页据此提供恢复入口 */
	async hiddenWorkspaces(): Promise<readonly WorkspaceSummary[]> {
		return (await request("/api/workspaces/hidden")) as readonly WorkspaceSummary[];
	},
	/** 恢复工作区；目录已不存在或恢复失败时返回 false */
	async restoreWorkspace(path: string): Promise<boolean> {
		const body = (await request("/api/workspaces/restore", {
			method: "POST",
			body: JSON.stringify({ path }),
		})) as { restored?: boolean };
		return body.restored ?? false;
	},
	/** 删除项目：内核会连同其名下活动与归档任务一起永久删除，返回实际删除的任务数 */
	async deleteWorkspace(path: string): Promise<number> {
		const body = (await request("/api/workspaces/delete", {
			method: "POST",
			body: JSON.stringify({ path }),
		})) as { deleted?: number };
		return body.deleted ?? 0;
	},
	async archivedSessions(): Promise<readonly SessionSummary[]> {
		return (await request("/api/sessions/archived")) as readonly SessionSummary[];
	},
	async deleteSessions(ids: readonly string[]): Promise<number> {
		const body = (await request("/api/sessions/delete", {
			method: "POST",
			body: JSON.stringify({ ids }),
		})) as { deleted?: number };
		return body.deleted ?? 0;
	},
	async archiveSessions(ids: readonly string[]): Promise<number> {
		const body = (await request("/api/sessions/archive", {
			method: "POST",
			body: JSON.stringify({ ids }),
		})) as { archived?: number };
		return body.archived ?? 0;
	},
	async restoreSessions(ids: readonly string[]): Promise<number> {
		const body = (await request("/api/sessions/restore", {
			method: "POST",
			body: JSON.stringify({ ids }),
		})) as { restored?: number };
		return body.restored ?? 0;
	},
	async switchSession(id: string): Promise<void> {
		await request("/api/session/switch", { method: "POST", body: JSON.stringify({ id }) });
	},
	async newSession(workspacePath: string | null): Promise<void> {
		await request("/api/session/new", {
			method: "POST",
			body: JSON.stringify({ workspacePath }),
		});
	},

	async models(): Promise<readonly ModelInfo[]> {
		return (await request("/api/models")) as readonly ModelInfo[];
	},
	async setModel(provider: string, model: string): Promise<void> {
		await request("/api/model", { method: "POST", body: JSON.stringify({ provider, model }) });
	},
	async setApprovalMode(mode: ApprovalMode): Promise<void> {
		await request("/api/approval-mode", { method: "POST", body: JSON.stringify({ mode }) });
	},
	async settings(): Promise<SettingsSnapshot> {
		return (await request("/api/settings")) as SettingsSnapshot;
	},
	async updateSettings(update: {
		effort?: ThinkingLevel;
		approval?: ApprovalMode;
		notify?: NotifyMode;
	}): Promise<SettingsSnapshot> {
		return (await request("/api/settings", {
			method: "POST",
			body: JSON.stringify(update),
		})) as SettingsSnapshot;
	},
	async personalization(): Promise<PersonalizationSnapshot> {
		return (await request("/api/personalization")) as PersonalizationSnapshot;
	},
	async savePersonalization(text: string): Promise<PersonalizationSnapshot> {
		return (await request("/api/personalization", {
			method: "PUT",
			body: JSON.stringify({ text }),
		})) as PersonalizationSnapshot;
	},
	async uploadSkillArchive(file: File): Promise<void> {
		const response = await fetch("/api/skills/upload", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/zip" },
			body: file,
		});
		const body: unknown = await response.json().catch(() => undefined);
		if (response.ok) return;
		const message = (body as { error?: unknown } | undefined)?.["error"];
		throw new Error(typeof message === "string" ? message : response.statusText);
	},
	async skillContent(path: string): Promise<SkillContent> {
		return (await request(
			`/api/skills/content?path=${encodeURIComponent(path)}`,
		)) as SkillContent;
	},
	async updateSkill(input: SkillUpdateInput): Promise<void> {
		await request("/api/skills/update", { method: "POST", body: JSON.stringify(input) });
	},
	async deleteSkill(path: string): Promise<void> {
		await request("/api/skills/delete", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
	},
	async addMcpServer(input: McpServerInput): Promise<void> {
		await request("/api/mcp-servers", { method: "POST", body: JSON.stringify(input) });
	},
	async mcpServer(name: string): Promise<McpServerInput> {
		return (await request(
			`/api/mcp-servers/detail?name=${encodeURIComponent(name)}`,
		)) as McpServerInput;
	},
	async updateMcpServer(input: McpServerInput): Promise<void> {
		await request("/api/mcp-servers/update", { method: "POST", body: JSON.stringify(input) });
	},
	async deleteMcpServer(name: string): Promise<void> {
		await request("/api/mcp-servers/delete", {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	},
	async reconnectMcpServer(name: string): Promise<string> {
		const body = (await request("/api/mcp-servers/reconnect", {
			method: "POST",
			body: JSON.stringify({ name }),
		})) as { message?: string };
		return body.message ?? "";
	},
	async providers(): Promise<readonly ProviderView[]> {
		return (await request("/api/providers")) as readonly ProviderView[];
	},
	async saveProvider(provider: ProviderInput): Promise<void> {
		await request("/api/providers", { method: "POST", body: JSON.stringify({ provider }) });
	},
	async deleteProvider(id: string): Promise<void> {
		await request("/api/providers/delete", { method: "POST", body: JSON.stringify({ id }) });
	},
	/** 用表单里的当前值试发一次最小请求；结果是结构化对象，不靠 HTTP 状态表达成败 */
	async testProvider(provider: ProviderInput, model: string): Promise<ProviderTestResult> {
		return (await request("/api/providers/test", {
			method: "POST",
			body: JSON.stringify({ provider, model }),
		})) as ProviderTestResult;
	},
	async setProviderEnabled(id: string, enabled: boolean): Promise<void> {
		await request("/api/providers", { method: "POST", body: JSON.stringify({ provider: { id, enabled } }) });
	},
	async setPlanMode(enabled: boolean): Promise<void> {
		await request("/api/plan-mode", { method: "POST", body: JSON.stringify({ enabled }) });
	},
	async compact(): Promise<void> {
		await request("/api/compact", { method: "POST" });
	},
	async fileTree(path: string): Promise<FileTree> {
		return (await request(`/api/files/tree?path=${encodeURIComponent(path)}`)) as FileTree;
	},
	async fileRead(path: string): Promise<FileContent> {
		return (await request(`/api/files/read?path=${encodeURIComponent(path)}`)) as FileContent;
	},
	async fileSearch(query: string, limit = 20): Promise<readonly FileSearchHit[]> {
		return (await request(
			`/api/files/search?q=${encodeURIComponent(query)}&limit=${limit}`,
		)) as readonly FileSearchHit[];
	},
	async gitStatus(): Promise<GitStatus | null> {
		return (await request("/api/git/status")) as GitStatus | null;
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
