import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeError } from "#src/shared/describe-error.ts";
import { loadSelection } from "#src/cli/config-selection.ts";
import type { CliOptions } from "#src/cli/args.ts";
import { writeStderr, writeStdout } from "#src/cli/output.ts";
import {
	assemblePipeline,
	createCompactor,
	createDriverFor,
	createLlmClient,
	createReviewer,
} from "#src/cli/pipeline.ts";
import { createSessionFor } from "#src/cli/session/factory.ts";
import {
	archiveSessionsAcross,
	deleteSessionsAcross,
	listArchivedSessions,
	listArchivedSessionsAcross,
	listSessions,
	listSessionsAcross,
	resumeSession,
	restoreSessionsAcross,
	sessionOwner,
} from "#src/cli/session/target.ts";
import type { ModelSelection } from "#src/config/selection.ts";
import type { ApprovalMode, Config } from "#src/config/file.ts";
import { configFilePath, providersFilePath } from "#src/config/paths.ts";
import { applyLiveConfig } from "#src/config/reload.ts";
import {
	appendMcpServerSection,
	removeMcpServerSection,
	updateMcpServerSection,
	updateModelSelection,
	updateUserConfigValue,
} from "#src/config/write-back.ts";
import { writeProviders } from "#src/config/providers-write.ts";
import type { Session } from "#src/session/session.ts";
import { lastContextTokens, sumActivity, sumUsage } from "#src/session/usage.ts";
import { parseSkillDraft } from "#src/skills/draft.ts";
import { defaultSkillRoots, discoverSkills, type SkillInfo } from "#src/skills/discover.ts";
import { installParsedSkill, parseSkillArchive } from "#src/skills/upload.ts";
import {
	deleteUserSkill,
	isEditableSkill,
	readSkillContent,
	updateUserSkill,
} from "#src/skills/manage.ts";
import { readVersion } from "#src/version.ts";
import {
	mcpServerDraft,
	mcpServerTable,
	parseMcpServerInput,
	parseMcpServerName,
} from "#src/web/mcp-servers.ts";
import { mergeProvider, providerViews, removeProvider } from "#src/web/providers.ts";
import {
	defaultInstructionSources,
	readInstructions,
	readPersonalization,
	writePersonalization,
	type PromptInstruction,
} from "#src/agent/instructions.ts";
import { ApprovalBroker } from "#src/permission/approval.ts";
import {
	PermissionGate,
	PermissionPolicy,
	type ApprovalAnswer,
} from "#src/permission/policy.ts";
import { WorkspaceBoundary } from "#src/workspace/boundary.ts";
import {
	canonicalWorkspacePath,
	dropWorkspace,
	listKnownWorkspaces,
	listWorkspaces,
	registerWorkspace,
	registeredWorkspace,
} from "#src/workspace/catalog.ts";
import { gitDiff, gitStatus } from "#src/workspace/git.ts";
import { workspaceNameOf } from "#src/workspace/name.ts";
import type { SessionListing } from "#src/session/store.ts";
import type { McpControl, McpStatusSource } from "#src/mcp/service.ts";
import { fileTree, readWorkspaceFile, searchWorkspaceFiles } from "#src/web/files.ts";
import { createWebServer, type WebServerDeps } from "#src/web/server.ts";
import { formatReadyLine } from "#src/web/ready-line.ts";
import { describeSettings, type SettingsUpdate } from "#src/web/settings.ts";

/**
 * 浏览器界面模式。
 *
 * 装配与非交互模式同一条管线(审批、工具、插件与沙箱只有一份),差别在两端:审批经
 * ApprovalBroker 交由网页回传,事件经 SSE 推给浏览器。整个进程一个会话,回合一次跑一个,
 * 正在跑的时候新提交按 409 拒绝——排队语义留给界面侧自己处理,这里不做隐藏队列。
 */

/** 审批结论的合法取值;传输层只给字符串,这里收窄后才准进审批桥。 */
const APPROVAL_ANSWERS: readonly ApprovalAnswer[] = ["once", "always", "deny"];
/** 审批方式的合法取值;与 config.toml 的语义一致,切换不落盘。 */
const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto", "yolo"];

/** 测试模型的上限：连不上或端点不回话时不让设置页一直转圈。 */
const MODEL_TEST_TIMEOUT_MS = 20_000;

interface ServeStartup {
	readonly desktopManaged?: boolean;
	readonly resumeSessionId?: string;
	readonly newWorkspacePath?: string;
}

export async function runServeMode(options: CliOptions, startup: ServeStartup = {}): Promise<number> {
	const loaded = await loadSelection(options);
	if (!loaded.ok) {
		writeStderr(`${loaded.error.display}\n`);
		return 1;
	}
	const { config: initialConfig, selection: initialSelection } = loaded.value;
	/** providers.json 可在设置页编辑；保存后重载这份清单与当前选择。 */
	let providersConfig = loaded.value.providersConfig;
	/** 可热更新的配置项会在设置页改动时整体替换；驱动每轮新建，下一轮就读到新值。 */
	let config = initialConfig;
	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	const workRoot = process.cwd();
	if (!startup.desktopManaged) registerWorkspace(workRoot);
	const workspace = new WorkspaceBoundary(workRoot);
	const instructions = (): readonly PromptInstruction[] =>
		readInstructions(defaultInstructionSources(workRoot, loaded.trusted));

	// 审批链路与全屏界面同构:策略先立起来,审查模型懒封装,决定靠网页回传
	const approvals = new ApprovalBroker();
	const policy = new PermissionPolicy(config.approval);
	const gate = new PermissionGate({
		policy,
		reviewer: config.approval === "auto" ? createReviewer(config, initialSelection, workRoot) : undefined,
		confirmer: approvals.request,
	});

	let mcpControl: McpControl | undefined;
	let mcpStatus: McpStatusSource | undefined;
	const pipeline = await assemblePipeline({
		config,
		workRoot,
		policy,
		gate,
		extensionContext: { mode: "tui", projectTrusted: loaded.trusted },
		onMcpStatus: (source) => {
			mcpStatus = source;
		},
		onMcpControl: (control) => {
			mcpControl = control;
		},
	});
	if (pipeline === null) return 1;
	const { registry, sandbox, sandboxWarnings, host } = pipeline;
	for (const warning of sandboxWarnings) writeStderr(`${warning}\n`);
	for (const line of pipeline.pluginReport) writeStderr(`reins: ${line.text}\n`);

	const sessionStore = host.sessionStore();
	let session: Session;
	if (startup.resumeSessionId !== undefined) {
		if (sessionStore === undefined) throw new Error("Cannot resume a session without a session store");
		session = resumeSession(workRoot, startup.resumeSessionId, sessionStore);
	} else {
		let workspacePath: string | null = null;
		if (startup.newWorkspacePath !== undefined) {
			const registered = registeredWorkspace(startup.newWorkspacePath);
			if (registered === undefined || !samePath(registered, workRoot)) {
				throw new Error("New task workspace is not the active registered workspace");
			}
			workspacePath = registered;
		} else if (startup.desktopManaged === true) {
			// 旧会话没有归属标记时按 cwd 推断项目，启动时新建的会话也照此办理；
			// 否则桌面壳明明停在某个工作区里，卡帽却显示成「未绑定」而没有解绑入口。
			// 只有主动取消绑定（newSession(null)）才写 null，两种状态由此区分。
			workspacePath = registeredWorkspace(workRoot) ?? null;
		}
		session = createSessionFor(workRoot, sessionStore, workspacePath);
	}
	const compactor = createCompactor(config, initialSelection);
	// 模型可在会话内热切换:只换主模型,压缩与审批模型保持启动时的选择(切模型不重建它们,
	// 语义是「下一轮回答换脑子」,不悄悄改审计链路)
	let selection: ModelSelection = initialSelection;

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
	/** 手动压缩与回合互斥：两边都会往同一个会话写条目。 */
	let compacting = false;
	let currentAbort: AbortController | undefined;
	let currentRun: Promise<void> | undefined;

	const workspaceRoots = (): readonly string[] => uniquePaths([...listKnownWorkspaces(), workRoot]);
	const workspaceFor = (
		workspacePath: string | null | undefined,
		cwd: string,
		visiblePaths: readonly string[],
	): string | null => {
		if (workspacePath === null) return null;
		let candidate = workspacePath;
		if (candidate === undefined) {
			if (cwd.length === 0) return null;
			try {
				candidate = canonicalWorkspacePath(cwd);
			} catch {
				return null;
			}
		}
		return visiblePaths.find((path) => samePath(path, candidate)) ?? null;
	};
	const sessionSummary = (item: SessionListing, visiblePaths: readonly string[]) => ({
		id: item.id,
		title: item.title,
		updatedAt: item.updatedAt,
		cwd: item.cwd,
		workspacePath: workspaceFor(item.workspacePath, item.cwd, visiblePaths),
	});

	/** 所有已登记空间的会话；旧会话仅在 cwd 精确匹配登记路径时归入项目。 */
	const sessions = () => {
		if (sessionStore === undefined) return [];
		const visiblePaths = listWorkspaces();
		return listSessionsAcross(workspaceRoots(), sessionStore).map((item) => sessionSummary(item, visiblePaths));
	};

	const visibleWorkspaces = () => {
		const namesFile = process.env["REINS_WORKSPACE_NAMES_FILE"];
		return listWorkspaces().map((path) => ({
			path,
			name: ((namesFile === undefined ? undefined : workspaceNameOf(namesFile, path)) ?? basename(path)) || path,
		}));
	};

	/** 从侧栏移除的项目：显示名与可见清单同源，设置页据此给出可枚举的恢复入口。 */
	const hiddenWorkspaces = () => {
		const namesFile = process.env["REINS_WORKSPACE_NAMES_FILE"];
		const visible = new Set(listWorkspaces());
		return listKnownWorkspaces()
			.filter((path) => !visible.has(path))
			.map((path) => ({
				path,
				name: ((namesFile === undefined ? undefined : workspaceNameOf(namesFile, path)) ?? basename(path)) || path,
			}));
	};

	/** 恢复只翻可见性，不切服务进程；目录已被手工删掉时明确失败，界面据此提示。 */
	const restoreWorkspace = (path: string): boolean => {
		try {
			registerWorkspace(path);
			return true;
		} catch {
			return false;
		}
	};

	/** 切会话/新建会话都只在空闲时允许:正在跑的回合属于旧会话,切断它等于毁掉结果。 */
	const switchToSession = (id: string): boolean => {
		if (running || compacting || sessionStore === undefined) return false;
		let next: Session;
		try {
			next = resumeSession(workRoot, id, sessionStore);
		} catch {
			return false;
		}
		void session.close();
		session = next;
		broadcast({ type: "session_switched" });
		return true;
	};

	const startNewSession = (workspacePath: string | null): boolean => {
		if (running || compacting) return false;
		let association: string | null = null;
		if (workspacePath !== null) {
			try {
				association = registeredWorkspace(workspacePath) ?? null;
			} catch {
				return false;
			}
			if (association === null || !samePath(association, workRoot)) return false;
		}
		void session.close();
		session = createSessionFor(workRoot, sessionStore, association);
		broadcast({ type: "session_switched" });
		return true;
	};

	/** 归档/删除的公共护栏:当前会话永远跳过,回合进行中一律不动。 */
	const archivedList = () => {
		if (sessionStore === undefined) return [];
		const visiblePaths = listWorkspaces();
		return listArchivedSessionsAcross(workspaceRoots(), sessionStore).map((item) =>
			sessionSummary(item, visiblePaths),
		);
	};

	const removeSessions = (ids: readonly string[]): number =>
		running || compacting || sessionStore === undefined
			? 0
			: deleteSessionsAcross(workspaceRoots(), sessionStore, ids, [session.id]);

	const stashSessions = (ids: readonly string[]): number =>
		running || compacting || sessionStore === undefined
			? 0
			: archiveSessionsAcross(workspaceRoots(), sessionStore, ids, [session.id]);

	const unstashSessions = (ids: readonly string[]): number =>
		running || compacting || sessionStore === undefined
			? 0
			: restoreSessionsAcross(workspaceRoots(), sessionStore, ids);

	/**
	 * 删除项目：把它名下的任务（活动与归档）一并永久删掉，不是归档。
	 *
	 * 名单取两路：一路按会话自己记的项目归属（界面上列在项目底下的就是这一批），一路按项目
	 * 的会话目录——早先的会话没有归属标记，项目摘出清单后就没有谁会再扫到它们了。
	 * 归属判定不能只用可见项目：项目从侧栏移除后，会话的归属在界面上会被抹成 null，
	 * 但文件还在该目录下；漏掉这批会留下删不掉、扫不着的孤儿，重新登记项目时又「复活」。
	 * 当前会话正属于这个项目时先离开它：还捏着写句柄的会话会把手下刚删掉的文件重新写出来。
	 * 回合进行中一律不动，返回 0，界面上项目原样留着。
	 */
	const removeWorkspaceTree = (path: string): number => {
		if (running || compacting || sessionStore === undefined) return 0;
		const belongsToTarget = (item: {
			readonly workspacePath?: string | null;
			readonly cwd?: string;
		}): boolean => {
			const owner = sessionOwner(item);
			return owner !== null && samePath(owner, path);
		};
		const attributed = [...sessions(), ...archivedList()]
			.filter(belongsToTarget)
			.map((item) => item.id);
		const stored = [...listSessions(path, sessionStore), ...listArchivedSessions(path, sessionStore)].map(
			(item) => item.id,
		);
		if (belongsToTarget(session)) startNewSession(null);
		const deleted = deleteSessionsAcross(workspaceRoots(), sessionStore, [...attributed, ...stored], [session.id]);
		dropWorkspace(path);
		return deleted;
	};

	const modelList = (): readonly { provider: string; model: string; name: string }[] =>
		providersConfig.providers
			.filter((provider) => provider.enabled)
			.flatMap((provider) =>
				provider.models.map((model) => ({ provider: provider.id, model: model.id, name: model.name })),
			);

	const currentModel = (): { provider: string; model: string; name: string } => ({
		provider: selection.provider.id,
		model: selection.model.id,
		name: selection.model.name,
	});

	/** 配置里的 server 与运行期状态按名字合并；配置存在但连接还没建时给出 unknown。 */
	const mcpServerRows = () => {
		const statuses = new Map((mcpStatus?.() ?? []).map((row) => [row.name, row]));
		return config.mcpServers.map((server) => {
			const live = statuses.get(server.name);
			return {
				name: server.name,
				type: server.type,
				disabled: server.disabled,
				status: live?.status ?? (server.disabled ? "disabled" : "unknown"),
				detail: live?.detail ?? "",
			};
		});
	};

	const settingsSnapshot = () =>
		describeSettings({
			version: readVersion(),
			configPath: configFile,
			providersPath: providersFile,
			config,
			selection,
			providers: providersConfig.providers,
			mcpServers: mcpServerRows(),
			plugins: pipeline.declarative.plugins.map((plugin) => ({
				name: plugin.name,
				kind: plugin.cordis ? "dsh" : plugin.extensions.length > 0 ? "pi" : "declarative",
				disabled: config.plugins.disabled.includes(plugin.name),
			})),
			skills: discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).map(skillInfo),
		});

	/**
	 * 应用设置页的可写项。
	 *
	 * 先落盘再换内存：写配置失败时界面上的值不能先变，否则使用者会以为已经保存。只有能热
	 * 更新的 effort、approval 与 notify 走到这里，其余项由设置页标成需要重启。
	 */
	const applySettings = (update: SettingsUpdate): { ok: boolean; error?: string } => {
		try {
			if (update.effort !== undefined) {
				updateUserConfigValue(["reasoning_effort"], () => update.effort as string, configFile);
			}
			if (update.approval !== undefined) {
				updateUserConfigValue(["approval"], () => update.approval as string, configFile);
			}
			if (update.notify !== undefined) {
				updateUserConfigValue(["ui", "notify"], () => update.notify as string, configFile);
			}
		} catch (error) {
			return { ok: false, error: describeError(error) };
		}

		const fields: (keyof typeof config)[] = [];
		if (update.effort !== undefined) fields.push("reasoningEffort");
		if (update.approval !== undefined) fields.push("approval");
		if (update.notify !== undefined) fields.push("ui");
		config = applyLiveConfig(
			config,
			{
				...config,
				...(update.effort === undefined ? {} : { reasoningEffort: update.effort }),
				...(update.approval === undefined ? {} : { approval: update.approval }),
				...(update.notify === undefined ? {} : { ui: { ...config.ui, notify: update.notify } }),
			},
			fields,
		);
		if (update.approval !== undefined) policy.setMode(update.approval);
		return { ok: true };
	};

	/** 新建与上传共用同一份重名判断：项目级同名技能会盖住用户级，不能只看目标目录。 */
	const skillExists = (name: string): boolean =>
		discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).some((skill) => skill.name === name);

	/** 设置页与技能面板共用同一份形状；editable 由服务端判定，界面只负责显示。 */
	const skillInfo = (skill: SkillInfo) => ({
		name: skill.name,
		description: skill.description,
		path: skill.path,
		scope: skill.scope,
		editable: isEditableSkill(skill),
	});

	const findSkill = (path: string): SkillInfo | undefined =>
		discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).find((skill) => skill.path === path);

	/** 提供方写回失败时恢复原文件；providers.json 里有 API Key，不能留下半份。 */
	const restoreProviders = (original: string | undefined): void => {
		if (original === undefined) {
			rmSync(providersFile, { force: true });
			return;
		}
		const temporary = `${providersFile}.${process.pid}.restore.tmp`;
		try {
			writeFileSync(temporary, original, "utf8");
			renameSync(temporary, providersFile);
		} catch {
			rmSync(temporary, { force: true });
		}
	};

	/** 重新解析配置与提供方；当前模型被删掉时 loadSelection 会返回可恢复错误。 */
	const reloadProviders = async (): Promise<{ readonly ok: boolean; readonly error?: string }> => {
		const reloaded = await loadSelection(options);
		if (!reloaded.ok) return { ok: false, error: describeError(reloaded.error) };
		providersConfig = reloaded.value.providersConfig;
		selection = reloaded.value.selection;
		config = {
			...config,
			provider: reloaded.value.config.provider,
			model: reloaded.value.config.model,
		};
		return { ok: true };
	};

	/**
	 * MCP 配置写盘的共同外壳。
	 *
	 * 先备份原文，写盘并重新加载配置；任何一步失败都恢复文件与内存。运行期接入、替换或
	 * 移除放在重载成功之后执行，失败同样回滚，避免配置文件与进程里的连接各说各话。
	 */
	const applyMcpConfigChange = async (
		mutate: (file: string) => void,
		runtime: (next: Config) => void,
	): Promise<{ readonly ok: boolean; readonly error?: string }> => {
		const original = existsSync(configFile) ? readFileSync(configFile, "utf8") : undefined;
		const previousConfig = config;
		const restore = (): void => {
			if (original === undefined) {
				rmSync(configFile, { force: true });
				return;
			}
			const temporary = `${configFile}.${process.pid}.restore.tmp`;
			try {
				writeFileSync(temporary, original, "utf8");
				renameSync(temporary, configFile);
			} catch {
				rmSync(temporary, { force: true });
			}
		};

		try {
			mutate(configFile);
			const reloaded = await loadSelection(options);
			if (!reloaded.ok) {
				restore();
				return { ok: false, error: describeError(reloaded.error) };
			}
			const next = reloaded.value.config;
			config = { ...config, mcpServers: next.mcpServers };
			try {
				runtime(next);
			} catch (error) {
				config = previousConfig;
				restore();
				return { ok: false, error: describeError(error) };
			}
			return { ok: true };
		} catch (error) {
			config = previousConfig;
			restore();
			return { ok: false, error: describeError(error) };
		}
	};

	const deps: WebServerDeps = {
		snapshot: () => {
			const id = approvals.pendingId();
			const usage = sumUsage(session.entries());
			const activity = sumActivity(session.entries());
			return {
				running: running || compacting,
				approval: id === undefined ? undefined : { id, request: approvals.pending() },
				approvalMode: policy.mode,
				model: currentModel(),
				version: readVersion(),
				sessionId: session.id,
				cwd: session.cwd,
				effort: config.reasoningEffort,
				planMode: policy.planMode,
				contextWindow: selection.model.contextWindow ?? config.contextWindow,
				contextTokens: lastContextTokens(session.entries()),
				usage: {
					requests: usage.requests,
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					total: usage.total,
					cost: usage.cost,
				},
				activity: {
					turns: activity.turns,
					steps: activity.steps,
					llmMs: activity.llmMs,
					toolMs: activity.toolMs,
					ttftMs: activity.ttftMs,
					ttftCount: activity.ttftCount,
					decodeTokens: activity.decodeTokens,
					decodeMs: activity.decodeMs,
				},
			};
		},
		session: () => ({
			id: session.id,
			cwd: session.cwd,
			workspacePath: workspaceFor(session.workspacePath, session.cwd, listWorkspaces()),
			entries: session.entries(),
		}),
		sessions,
		workspaces: visibleWorkspaces,
		hiddenWorkspaces,
		restoreWorkspace,
		deleteWorkspace: removeWorkspaceTree,
		switchSession: switchToSession,
		newSession: startNewSession,
		archivedSessions: archivedList,
		deleteSessions: removeSessions,
		archiveSessions: stashSessions,
		restoreSessions: unstashSessions,
		skills: () => discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).map(skillInfo),
		plugins: () =>
			pipeline.declarative.plugins.map((plugin) => ({
				name: plugin.name,
				kind: plugin.cordis ? "dsh" : plugin.extensions.length > 0 ? "pi" : "declarative",
				disabled: config.plugins.disabled.includes(plugin.name),
			})),
		pluginLogs: (name, limit) => pipeline.host.logs.lines(name, limit),
		settings: settingsSnapshot,
		applySettings,
		personalization: readPersonalization,
		savePersonalization: (text) => {
			try {
				writePersonalization(text);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		providers: () => providerViews(providersConfig),
		testProvider: async (body) => {
			const input = body["provider"];
			const modelId = body["model"];
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return { ok: false, error: "提供方数据无效" };
			}
			if (typeof modelId !== "string" || modelId.length === 0) {
				return { ok: false, error: "请选择要测试的模型" };
			}
			const draft = input as Record<string, unknown>;
			const id = draft["id"];
			if (typeof id !== "string") return { ok: false, error: "请填写提供方 ID" };

			// 用表单里的当前值试；密钥留空时沿用已保存的那一份，未保存的改动也能先验证
			const merged = mergeProvider(providersConfig, draft, providersFile);
			if (!merged.ok || merged.config === undefined) {
				return { ok: false, error: merged.error ?? "提供方配置无效" };
			}
			const provider = merged.config.providers.find((item) => item.id === id);
			const model = provider?.models.find((item) => item.id === modelId);
			if (provider === undefined || model === undefined) {
				return { ok: false, error: "找不到这个模型" };
			}
			if (model.disabled) {
				return { ok: false, error: "该模型已停用，请先启用再测试" };
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
			const started = Date.now();
			try {
				const result = await createLlmClient(config, provider, model)
					.stream({
						model: model.id,
						system: "You are a connectivity probe. Reply with a single word: OK.",
						messages: [{ role: "user", content: "ping" }],
						tools: [],
						maxTokens: 24,
						effort: undefined,
						signal: controller.signal,
					})
					.result();
				const ms = Date.now() - started;
				if (result.stopReason === "error" || result.stopReason === "aborted") {
					return {
						ok: false,
						ms,
						error:
							result.stopReason === "aborted"
								? `请求超时（${MODEL_TEST_TIMEOUT_MS / 1000} 秒内没有响应）`
								: (result.errorMessage ?? "请求失败"),
					};
				}
				const text = result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("")
					.trim();
				return { ok: true, ms, model: result.model, text };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			} finally {
				clearTimeout(timer);
			}
		},
		saveProvider: async (body) => {
			const input = body["provider"];
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return { ok: false, error: "提供方数据无效" };
			}
			const draft = input as Record<string, unknown>;
			const id = draft["id"];
			if (typeof id !== "string") return { ok: false, error: "请填写提供方 ID" };
			if (id === selection.provider.id) {
				const models = draft["models"];
				if (
					Array.isArray(models) &&
					!models.some(
						(model) =>
							typeof model === "object" &&
							model !== null &&
							(model as Record<string, unknown>)["id"] === selection.model.id,
					)
				) {
					return { ok: false, error: "当前正在使用该模型，请先切换到其他模型" };
				}
			}

			const merged = mergeProvider(providersConfig, draft, providersFile);
			if (!merged.ok || merged.config === undefined) {
				return { ok: false, error: merged.error ?? "提供方配置无效" };
			}
			const original = existsSync(providersFile) ? readFileSync(providersFile, "utf8") : undefined;
			try {
				writeProviders(merged.config, providersFile);
				const reloaded = await reloadProviders();
				if (!reloaded.ok) {
					restoreProviders(original);
					return { ok: false, error: reloaded.error ?? "无法重新加载提供方" };
				}
				return { ok: true };
			} catch (error) {
				restoreProviders(original);
				return { ok: false, error: describeError(error) };
			}
		},
		deleteProvider: async (body) => {
			const id = body["id"];
			if (typeof id !== "string" || id.length === 0) {
				return { ok: false, error: "缺少提供方 ID" };
			}
			if (id === selection.provider.id) {
				return { ok: false, error: "当前正在使用该提供方，请先切换模型" };
			}
			const removed = removeProvider(providersConfig, id, providersFile);
			if (!removed.ok || removed.config === undefined) {
				return { ok: false, error: removed.error ?? "提供方配置无效" };
			}
			const original = existsSync(providersFile) ? readFileSync(providersFile, "utf8") : undefined;
			try {
				writeProviders(removed.config, providersFile);
				const reloaded = await reloadProviders();
				if (!reloaded.ok) {
					restoreProviders(original);
					return { ok: false, error: reloaded.error ?? "无法重新加载提供方" };
				}
				return { ok: true };
			} catch (error) {
				restoreProviders(original);
				return { ok: false, error: describeError(error) };
			}
		},
		uploadSkill: (archive) => {
			try {
				const parsed = parseSkillArchive(archive);
				if (skillExists(parsed.name)) {
					return { ok: false, error: `技能 ${parsed.name} 已存在` };
				}
				installParsedSkill(parsed);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		skillContent: (path) => {
			const skill = findSkill(path);
			if (skill === undefined) return { ok: false, error: "技能不存在" };
			if (!isEditableSkill(skill)) {
				return { ok: false, error: `技能 ${skill.name} 是只读的` };
			}
			try {
				return { ok: true, skill: readSkillContent(skill) };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		updateSkill: (body) => {
			const path = body["path"];
			if (typeof path !== "string" || path.length === 0) {
				return { ok: false, error: "缺少技能路径" };
			}
			const skill = findSkill(path);
			if (skill === undefined) return { ok: false, error: "技能不存在" };
			if (!isEditableSkill(skill)) {
				return { ok: false, error: `技能 ${skill.name} 是只读的` };
			}
			const parsed = parseSkillDraft(body);
			if (!parsed.ok || parsed.draft === undefined) {
				return { ok: false, error: parsed.error ?? "技能配置无效" };
			}
			try {
				updateUserSkill(skill, parsed.draft);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		deleteSkill: (body) => {
			const path = body["path"];
			if (typeof path !== "string" || path.length === 0) {
				return { ok: false, error: "缺少技能路径" };
			}
			const skill = findSkill(path);
			if (skill === undefined) return { ok: false, error: "技能不存在" };
			if (!isEditableSkill(skill)) {
				return { ok: false, error: `技能 ${skill.name} 是只读的` };
			}
			try {
				deleteUserSkill(skill);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		addMcpServer: async (body) => {
			const parsed = parseMcpServerInput(body);
			if (!parsed.ok || parsed.draft === undefined) {
				return { ok: false, error: parsed.error ?? "MCP 服务器配置无效" };
			}
			const draft = parsed.draft;
			if (config.mcpServers.some((server) => server.name === draft.name)) {
				return { ok: false, error: `MCP 服务器 ${draft.name} 已存在` };
			}
			return applyMcpConfigChange(
				(file) => appendMcpServerSection(draft.name, mcpServerTable(draft), file),
				(next) => {
					const server = next.mcpServers.find((item) => item.name === draft.name);
					if (server === undefined) throw new Error("写入配置后没有找到 MCP 服务器");
					mcpControl?.addServer(server);
				},
			);
		},
		mcpServerDetail: (name) => {
			const server = config.mcpServers.find((item) => item.name === name);
			return server === undefined ? undefined : mcpServerDraft(server);
		},
		updateMcpServer: async (body) => {
			if (running || compacting) {
				return { ok: false, error: "回合进行中，暂时不能修改 MCP 服务器" };
			}
			const parsed = parseMcpServerInput(body);
			if (!parsed.ok || parsed.draft === undefined) {
				return { ok: false, error: parsed.error ?? "MCP 服务器配置无效" };
			}
			const draft = parsed.draft;
			const existing = config.mcpServers.find((server) => server.name === draft.name);
			if (existing === undefined) {
				return { ok: false, error: `MCP 服务器 ${draft.name} 不存在` };
			}
			const values = mcpServerTable(draft);
			// 表单不暴露的高级项保持原值，避免编辑一次就丢掉
			if (existing.timeoutSeconds !== undefined) values.timeout = existing.timeoutSeconds;
			if (existing.disabled) values.disabled = true;
			return applyMcpConfigChange(
				(file) => updateMcpServerSection(draft.name, values, file),
				(next) => {
					const server = next.mcpServers.find((item) => item.name === draft.name);
					if (server === undefined) throw new Error("写入配置后没有找到 MCP 服务器");
					mcpControl?.replaceServer(server);
				},
			);
		},
		deleteMcpServer: async (body) => {
			if (running || compacting) {
				return { ok: false, error: "回合进行中，暂时不能修改 MCP 服务器" };
			}
			const parsed = parseMcpServerName(body["name"]);
			if (!parsed.ok || parsed.name === undefined) {
				return { ok: false, error: parsed.error ?? "MCP 服务器名称无效" };
			}
			const name = parsed.name;
			if (!config.mcpServers.some((server) => server.name === name)) {
				return { ok: false, error: `MCP 服务器 ${name} 不存在` };
			}
			return applyMcpConfigChange(
				(file) => removeMcpServerSection(name, file),
				() => mcpControl?.removeServer(name),
			);
		},
		reconnectMcpServer: async (body) => {
			const parsed = parseMcpServerName(body["name"]);
			if (!parsed.ok || parsed.name === undefined) {
				return { ok: false, error: parsed.error ?? "MCP 服务器名称无效" };
			}
			const name = parsed.name;
			if (!config.mcpServers.some((server) => server.name === name)) {
				return { ok: false, error: `MCP 服务器 ${name} 不存在` };
			}
			if (mcpControl === undefined) return { ok: false, error: "MCP 控制未就绪" };
			try {
				return { ok: true, message: await mcpControl.reconnect(name) };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		fileTree: (path) => fileTree(workspace, path),
		fileRead: (path) => readWorkspaceFile(workspace, path),
		fileSearch: (query, limit) => searchWorkspaceFiles(workspace, query, limit),
		gitStatus: () => gitStatus(workRoot) ?? null,
		gitDiff: (path, staged) => gitDiff(workRoot, path, staged) ?? null,
		models: modelList,
		setModel: (provider, model) => {
			const found = providersConfig.providers.find((item) => item.id === provider);
			const entry = found?.models.find((item) => item.id === model);
			if (found === undefined || entry === undefined) return false;
			try {
				updateModelSelection(provider, model, configFile);
			} catch (error) {
				broadcast({ type: "error", message: describeError(error) });
				return false;
			}
			selection = { ...selection, provider: found, model: entry };
			return true;
		},
		setApprovalMode: (mode) => {
			if (!APPROVAL_MODES.includes(mode as ApprovalMode)) return false;
			const next = mode as ApprovalMode;
			policy.setMode(next);
			// 热切换只影响本进程，不写配置；设置页里的 approval 才会落盘
			config = { ...config, approval: next };
			return true;
		},
		setPlanMode: (enabled) => {
			policy.setPlanMode(enabled);
		},
		submit: (text) => {
			if (running || compacting) return false;
			running = true;
			currentAbort = new AbortController();
			currentRun = (async () => {
				try {
					const driver = createDriverFor(
						{ config, selection, compactor },
						{
							registry,
							session,
							workspace,
							sandbox,
							instructions,
							skills: () => discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)),
						},
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
		compact: () => {
			if (running || compacting || compactor === undefined) return false;
			compacting = true;
			const driver = createDriverFor(
				{ config, selection, compactor },
				{
					registry,
					session,
					workspace,
					sandbox,
					instructions,
					skills: () => discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)),
				},
				(event) => broadcast(event),
			);
			const controller = new AbortController();
			void driver
				.compact(controller.signal)
				.catch((error: unknown) => broadcast({ type: "error", message: describeError(error) }))
				.finally(() => {
					compacting = false;
				});
			return true;
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
		// 机器可读的就绪行:壳只认 stdout 上的这一行,其余输出都给人看
		writeStdout(formatReadyLine({ port: server.port, token }) + "\n");

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

function uniquePaths(paths: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		const resolved = resolve(path);
		const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(path);
	}
	return unique;
}

function samePath(left: string, right: string): boolean {
	const leftPath = canonicalPathForComparison(left);
	const rightPath = canonicalPathForComparison(right);
	return process.platform === "win32"
		? leftPath.toLowerCase() === rightPath.toLowerCase()
		: leftPath === rightPath;
}

function canonicalPathForComparison(path: string): string {
	try {
		return canonicalWorkspacePath(path);
	} catch {
		return resolve(path);
	}
}

/** 界面构建产物目录:环境变量优先(桌面打包传 unpacked 路径),否则按仓库布局推导。 */
function staticRoot(): string | undefined {
	const override = process.env["REINS_UI_DIST"];
	if (override !== undefined && override.length > 0 && existsSync(override)) return override;
	const root = fileURLToPath(new URL("../../web/dist", import.meta.url));
	return existsSync(root) ? root : undefined;
}
