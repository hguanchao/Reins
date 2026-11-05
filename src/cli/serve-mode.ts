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
	createReviewer,
} from "#src/cli/pipeline.ts";
import { createSessionFor } from "#src/cli/session/factory.ts";
import {
	archiveSessionsAcross,
	deleteSessionsAcross,
	listArchivedSessionsAcross,
	listSessionsAcross,
	resumeSession,
	restoreSessionsAcross,
} from "#src/cli/session/target.ts";
import type { ModelSelection } from "#src/config/selection.ts";
import type { ApprovalMode } from "#src/config/file.ts";
import { configFilePath, providersFilePath } from "#src/config/paths.ts";
import { applyLiveConfig } from "#src/config/reload.ts";
import { appendMcpServerSection, updateModelSelection, updateUserConfigValue } from "#src/config/write-back.ts";
import { writeProviders } from "#src/config/providers-write.ts";
import type { Session } from "#src/session/session.ts";
import { lastContextTokens, sumActivity, sumUsage } from "#src/session/usage.ts";
import { createUserSkill, createUserSkillFromContent, parseSkillDraft, parseSkillUpload } from "#src/skills/create.ts";
import { defaultSkillRoots, discoverSkills } from "#src/skills/discover.ts";
import { readVersion } from "#src/version.ts";
import { mcpServerTable, parseMcpServerInput } from "#src/web/mcp-servers.ts";
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
	listKnownWorkspaces,
	listWorkspaces,
	registerWorkspace,
	registeredWorkspace,
} from "#src/workspace/catalog.ts";
import { gitDiff, gitStatus } from "#src/workspace/git.ts";
import { workspaceNameOf } from "#src/workspace/name.ts";
import type { SessionListing } from "#src/session/store.ts";
import type { McpControl } from "#src/mcp/service.ts";
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

	const modelList = (): readonly { provider: string; model: string; name: string }[] =>
		providersConfig.providers.flatMap((provider) =>
			provider.models.map((model) => ({ provider: provider.id, model: model.id, name: model.name })),
		);

	const currentModel = (): { provider: string; model: string; name: string } => ({
		provider: selection.provider.id,
		model: selection.model.id,
		name: selection.model.name,
	});

	const settingsSnapshot = () =>
		describeSettings({
			version: readVersion(),
			configPath: configFile,
			providersPath: providersFile,
			config,
			selection,
			providers: providersConfig.providers,
			mcpServers: config.mcpServers.map((server) => ({
				name: server.name,
				type: server.type,
				disabled: server.disabled,
			})),
			plugins: pipeline.declarative.plugins.map((plugin) => ({
				name: plugin.name,
				kind: plugin.cordis ? "dsh" : plugin.extensions.length > 0 ? "pi" : "declarative",
				disabled: config.plugins.disabled.includes(plugin.name),
			})),
			skills: discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).map((skill) => ({
				name: skill.name,
				description: skill.description,
				path: skill.path,
			})),
		});

	/**
	 * 应用设置页的可写项。
	 *
	 * 先落盘再换内存：写配置失败时界面上的值不能先变，否则使用者会以为已经保存。只有能热
	 * 更新的 effort 与 approval 走到这里，其余项由设置页标成需要重启。
	 */
	const applySettings = (update: SettingsUpdate): { ok: boolean; error?: string } => {
		try {
			if (update.effort !== undefined) {
				updateUserConfigValue(["reasoning_effort"], () => update.effort as string, configFile);
			}
			if (update.approval !== undefined) {
				updateUserConfigValue(["approval"], () => update.approval as string, configFile);
			}
		} catch (error) {
			return { ok: false, error: describeError(error) };
		}

		const fields: (keyof typeof config)[] = [];
		if (update.effort !== undefined) fields.push("reasoningEffort");
		if (update.approval !== undefined) fields.push("approval");
		config = applyLiveConfig(
			config,
			{
				...config,
				...(update.effort === undefined ? {} : { reasoningEffort: update.effort }),
				...(update.approval === undefined ? {} : { approval: update.approval }),
			},
			fields,
		);
		if (update.approval !== undefined) policy.setMode(update.approval);
		return { ok: true };
	};

	/** 新建与上传共用同一份重名判断：项目级同名技能会盖住用户级，不能只看目标目录。 */
	const skillExists = (name: string): boolean =>
		discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).some((skill) => skill.name === name);

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
		switchSession: switchToSession,
		newSession: startNewSession,
		archivedSessions: archivedList,
		deleteSessions: removeSessions,
		archiveSessions: stashSessions,
		restoreSessions: unstashSessions,
		skills: () =>
			discoverSkills(defaultSkillRoots(workRoot, loaded.trusted)).map((skill) => ({
				name: skill.name,
				description: skill.description,
				path: skill.path,
			})),
		plugins: () =>
			pipeline.declarative.plugins.map((plugin) => ({
				name: plugin.name,
				kind: plugin.cordis ? "dsh" : plugin.extensions.length > 0 ? "pi" : "declarative",
				disabled: config.plugins.disabled.includes(plugin.name),
			})),
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
		createSkill: (body) => {
			const parsed = parseSkillDraft(body);
			if (!parsed.ok || parsed.draft === undefined) {
				return { ok: false, error: parsed.error ?? "技能配置无效" };
			}
			const draft = parsed.draft;
			if (skillExists(draft.name)) {
				return { ok: false, error: `技能 ${draft.name} 已存在` };
			}
			try {
				createUserSkill(draft);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: describeError(error) };
			}
		},
		uploadSkill: (body) => {
			const parsed = parseSkillUpload(body);
			if (!parsed.ok || parsed.draft === undefined) {
				return { ok: false, error: parsed.error ?? "技能配置无效" };
			}
			const draft = parsed.draft;
			if (skillExists(draft.name)) {
				return { ok: false, error: `技能 ${draft.name} 已存在` };
			}
			try {
				createUserSkillFromContent(draft.name, draft.content);
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
				appendMcpServerSection(draft.name, mcpServerTable(draft), configFile);
				const reloaded = await loadSelection(options);
				if (!reloaded.ok) {
					restore();
					return { ok: false, error: describeError(reloaded.error) };
				}
				const server = reloaded.value.config.mcpServers.find((item) => item.name === draft.name);
				if (server === undefined) {
					restore();
					return { ok: false, error: "写入配置后没有找到 MCP 服务器" };
				}
				config = { ...config, mcpServers: reloaded.value.config.mcpServers };
				try {
					mcpControl?.addServer(server);
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
		compact: () => {
			if (running || compacting || compactor === undefined) return false;
			compacting = true;
			const driver = createDriverFor(
				{ config, selection, compactor },
				{ registry, session, workspace, sandbox, instructions },
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
