import { describeError } from "../shared/describe-error.ts";
import { CheckpointService } from "../checkpoint/service.ts";
import type { AgentEventListener } from "../agent/events.ts";
import {
	defaultInstructionSources,
	readInstructions,
	type PromptInstruction,
} from "../agent/instructions.ts";
import type { ApprovalMode, Config } from "../config/file.ts";
import { ModelCatalog } from "../config/model-catalog.ts";
import {
	configFilePath,
	projectConfigFilePath,
	providersFilePath,
} from "../config/paths.ts";
import { applyLiveConfig, diffConfig } from "../config/reload.ts";
import { lastContextTokens } from "../session/usage.ts";
import { PermissionGate, PermissionPolicy } from "../permission/policy.ts";
import { ApprovalBroker } from "../permission/approval.ts";
import type { McpStatusSource } from "../mcp/service.ts";
import { Session } from "../session/session.ts";
import { defaultSkillRoots, discoverSkills, type SkillInfo } from "../skills/discover.ts";
import { imageBlock, type ImageAttachment } from "../tui/image.ts";
import { buildTranscriptHistory } from "../tui/transcript/history.ts";
import { runTui } from "../tui/layout.ts";
import type {
	ApprovalModeSource,
	CheckpointSource,
	PlanModeSource,
	SessionMenuSource,
} from "../tui/options.ts";
import { JobManager } from "../tools/jobs.ts";
import { fileEntries } from "../workspace/walk.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { recordTrust } from "../workspace/trust.ts";
import { readVersion } from "../version.ts";
import { sessionAge } from "./session/age.ts";
import {
	configFileStamp,
	loadSelection,
	readConfigQuietly,
} from "./config-selection.ts";
import { createClipboardSource } from "./clipboard.ts";
import { createImageSource } from "./image-reader.ts";
import { initializeConfig } from "./initialize-config.ts";
import { writeStderr, writeStdout } from "./output.ts";
import { assemblePipeline, createCompactor, createDriverFor } from "./pipeline.ts";
import { createSessionFor, sessionTitle } from "./session/factory.ts";
import { createSession, forkSession, listSessions, resumeCommand, resumeSession } from "./session/target.ts";
import { openSessionForSwitch } from "./session/switch.ts";
import { createStartupTimer } from "./startup-timer.ts";
import {
	abbreviateHome,
	createDynamicReviewer,
	createEffortMenuSource,
	createFooterInfo,
	createModelMenuSource,
	createUnavailableFooterInfo,
} from "./tui-sources.ts";
import type { CliOptions } from "./args.ts";

/** @ 补全一次最多索引的文件数；只影响补全，不影响 find/grep 自己的遍历上限。 */
const MAX_FILE_COMPLETION_FILES = 20_000;

/**
 * 启动全屏界面。
 *
 * 备用屏只有在真实终端上才有意义；输入输出被重定向时直接报错，避免程序在管道里挂起等待
 * 一个永远不会到来的按键。确认界面起得来之后先静默补齐缺失的配置模板，再读配置。
 *
 * 配置读不出来也照常进入界面：主区域用一行提示说明原因，输入不产生对话。只有
 * provider/model 对不上时仍建立模型目录，/model 选中后写回配置并恢复；完整的文件与行列
 * 信息由非交互模式输出，界面里只保留最短的必要信息。
 *
 * 会话文件在配置正常时启动即建立；受限模式下等到选型成功后再建立，避免留下一个空会话。
 */
export async function runTuiMode(options: CliOptions): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		writeStderr("reins: the full-screen interface needs an interactive terminal; pass a prompt to run non-interactively\n");
		return 1;
	}

	// 确认界面起得来才补配置模板：起不来时不在磁盘上留下半套准备
	initializeConfig(options);

	// 首帧之前的每一步都记一笔：慢在哪只能看数据，插件与沙箱是最可能拖时间的两处
	const startup = createStartupTimer({ env: process.env, write: writeStderr });
	const loaded = await loadSelection(options);

	const workRoot = process.cwd();
	/**
	 * 工作区信任。信任名单由界面里的信任页翻转；技能与规则的读取都在闭包内取值，
	 * 所以授予信任后下一轮就会带上项目里的内容，不必重启。
	 */
	let workspaceTrusted = "trusted" in loaded && loaded.trusted;

	// 技能与规则每轮重扫：改完 SKILL.md / AGENTS.md 下一轮就生效，不必重启
	const skillRoots = () => defaultSkillRoots(workRoot, workspaceTrusted);
	const skills = (): readonly SkillInfo[] => discoverSkills(skillRoots());
	const instructions = (): readonly PromptInstruction[] =>
		readInstructions(defaultInstructionSources(workRoot, workspaceTrusted));
	const skillsPage = {
		list: () =>
			skills().map((skill) => ({
				name: skill.name,
				description: skill.description.length === 0 ? "(no description)" : skill.description,
				note: abbreviateHome(skill.directory),
				scope: skill.scope,
			})),
		directories: () => skillRoots().map((root) => root.directory),
	};

	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	// 配置完全读不出来：只显示警告，不装配 agent，/model 与 /effort 都不可用
	if (!loaded.ok && !loaded.recoverable) {
		const session = createSession(workRoot, undefined);
		try {
			return await runTui({
				version: readVersion(),
				info: createUnavailableFooterInfo(workRoot, session),
				warning: `Warning: ${loaded.error.message}`,
				ready: false,
				skills: skillsPage,
				clipboard: createClipboardSource(),
			});
		} catch (error) {
			writeStderr(`reins: ${describeError(error)}\n`);
			return 1;
		} finally {
			await session.close();
		}
	}

	const config = loaded.ok ? loaded.value.config : loaded.config;
	const providersConfig = loaded.ok ? loaded.value.providersConfig : loaded.providersConfig;
	const initialSelection = loaded.ok ? loaded.value.selection : undefined;
	startup.mark("config");

	// 权限、工具、插件与沙箱：与非交互模式使用同一条装配路径
	const approvals = new ApprovalBroker();
	const policy = new PermissionPolicy(config.approval);
	const catalog = new ModelCatalog(providersConfig, config, initialSelection);
	let activeConfig = config;
	/** 上一轮看到的配置文件版本；变了就重读一次 */
	let configStamp = configFileStamp(configFile, projectConfigFilePath(workRoot));
	// 交互模式的审查模型常驻：它是懒封装（只在真的走到 review 那一步才建客户端），
	// 启动时不花钱。审批方式能靠 Shift+Tab 在运行中切到 auto，此时必须已经有审查者可用，
	// 不能像非交互模式那样按启动配置决定要不要挂。
	const reviewer = createDynamicReviewer(catalog, () => activeConfig, workRoot);
	const gate = new PermissionGate({
		policy,
		reviewer,
		confirmer: approvals.request,
	});
	/** MCP 连接清单由插件装载时交过来；插件缺席时保持 undefined，/mcps 也随之不可用。 */
	let mcpStatus: McpStatusSource | undefined;
	const jobs = new JobManager({ shellPath: config.shellPath });
	const pipeline = await assemblePipeline({
		config,
		workRoot,
		policy,
		gate,
		jobs,
		onMcpStatus: (source) => {
			mcpStatus = source;
		},
		onStage: (stage) => startup.mark(stage),
	});
	if (pipeline === null) return 1;
	const { registry, host, sandbox, sandboxInfo, sandboxWarnings } = pipeline;

	const workspace = new WorkspaceBoundary(workRoot);
	startup.mark("sandbox");
	const store = host.sessionStore();
	let session: Session | undefined;
	try {
		session =
			options.resume === undefined
				? createSessionFor(workRoot, store)
				: store === undefined
					? (() => {
							throw new Error("No session store; cannot resume this session");
						})()
					: resumeSession(workRoot, options.resume, store);
		if (options.resume === undefined && loaded.ok) session.begin();
	} catch (error) {
		await session?.close();
		writeStderr(`reins: ${describeError(error)}\n`);
		return 1;
	}
	// 当前会话会被 /session 菜单替换；后续所有装配都读这个可变引用
	let activeSession: Session = session;
	startup.mark("session");

	let pendingUndoNotice: string | undefined;
	/** 撤销提醒只交给下一轮：driver 建好并同步提示词时取一次。 */
	const takeUndoNotice = (): string | undefined => {
		const notice = pendingUndoNotice;
		pendingUndoNotice = undefined;
		return notice;
	};
	let checkpoints = new CheckpointService({
		workRoot,
		sessionId: activeSession.id,
		onUndo: (message) => {
			pendingUndoNotice = message;
		},
	});
	await checkpoints.init();
	const checkpointSource: CheckpointSource = {
		available: () => checkpoints.available,
		error: () => checkpoints.lastError,
		list: () => checkpoints.list(),
		latestUndoable: async () => {
			await checkpoints.init();
			return checkpoints.latestUndoable();
		},
		preview: async (id) => {
			await checkpoints.init();
			return checkpoints.preview(id);
		},
		restore: async (id) => {
			await checkpoints.init();
			return checkpoints.restore(id);
		},
	};
	startup.mark("checkpoints");

	let sessionPersisted =
		options.resume !== undefined || (loaded.ok && activeSession.path !== null);
	/** 从受限模式恢复后补建会话文件；失败只报告，不阻止本次使用。 */
	const markSessionReady = (): void => {
		if (sessionPersisted || activeSession.path === null) return;
		try {
			activeSession.begin();
			sessionPersisted = true;
		} catch (error) {
			writeStderr(
				`reins: could not create session file: ${describeError(error)}\n`,
			);
		}
	};

	let footerInfo =
		initialSelection !== undefined
			? createFooterInfo(workRoot, activeConfig, initialSelection, activeSession)
			: createUnavailableFooterInfo(workRoot, activeSession);
	const history = buildTranscriptHistory(activeSession.state().messages, workRoot);
	const refreshInfo = (): void => {
		const current = catalog.selection;
		footerInfo =
			current === undefined
				? createUnavailableFooterInfo(workRoot, activeSession)
				: createFooterInfo(workRoot, activeConfig, current, activeSession);
	};

	/**
	 * 信任页授予之后要做的事。
	 *
	 * 记录只是写一份用户级配置，真正要处理的是「项目配置现在才生效」。这里沿用热重载的
	 * 分界线：每轮重建的项立即换上，启动时已被别的对象拿走的项明说要重启——假装全部
	 * 生效，最后只会剩一个「配置写了却没用」的疑问。
	 */
	const acceptTrust = async (remember: boolean): Promise<readonly string[]> => {
		if (remember) recordTrust(workRoot, true);
		workspaceTrusted = true;
		const lines = [remember ? `Trusted ${workRoot}` : `Trusted ${workRoot} for this session`];

		let next: Config;
		try {
			next = readConfigQuietly(options, workRoot, true);
		} catch (error) {
			lines.push(`workspace config could not be read: ${describeError(error)}`);
			return lines;
		}
		// 重读过一次就把版本号记下来，免得下一轮把这次重读当成文件变动再报一遍
		configStamp = configFileStamp(configFile, projectConfigFilePath(workRoot));

		const diff = diffConfig(activeConfig, next);
		if (diff.live.length > 0) {
			activeConfig = applyLiveConfig(activeConfig, next, diff.live);
			refreshInfo();
			lines.push(`applied now: ${diff.live.join(", ")}`);
		}
		if (diff.restart.length > 0) lines.push(`restart to apply: ${diff.restart.join(", ")}`);
		return lines;
	};

	/**
	 * 只在还没有任何结论时问一次。
	 *
	 * 命令行旗标与保存过的记录都已经定下结论，再问一遍等于不承认它。目录里没有需要信任
	 * 的东西时 source 是 none，同样不打扰。
	 */
	/** 使用者在信任页拒绝了：界面会直接退出，这里记下原因以便收尾时说明。 */
	let trustDeclined = false;
	const trustPrompt =
		"trust" in loaded && loaded.trust.source === "default"
			? {
					root: workRoot,
					files: loaded.resources.files,
					skillDirectories: loaded.resources.skillDirectories,
					accept: acceptTrust,
					decline: () => {
						trustDeclined = true;
					},
				}
			: undefined;

	/**
	 * 把一个已经打开的会话接成当前会话。
	 *
	 * 旧会话先释放写入器，之后条目才只落到新会话里。Plan 与检查点都是会话级状态，换会话
	 * 就回到普通模式并换索引；待撤销提醒属于旧会话的下一轮，也一并清掉。
	 */
	const adoptSession = (next: Session): void => {
		const previous = activeSession;
		void previous.close().catch((error: unknown) => {
			writeStderr(
				`reins: could not close the previous session: ${describeError(error)}\n`,
			);
		});
		activeSession = next;
		sessionPersisted = next.path !== null;
		policy.setPlanMode(false);
		pendingUndoNotice = undefined;
		checkpoints = new CheckpointService({
			workRoot,
			sessionId: next.id,
			onUndo: (message) => {
				pendingUndoNotice = message;
			},
		});
		void checkpoints.init();
		refreshInfo();
	};

	/**
	 * 配置变了就重读一次。
	 *
	 * 只应用每轮重新读取的那部分，其余明确说「要重启」——配置项一半生效、一半不生效，
	 * 比整体不生效更难解释清楚到底发生了什么。
	 *
	 * 返回一句给使用者看的话；文件没动过时返回 undefined。
	 */
	const reloadConfigIfChanged = (): string | undefined => {
		const stamp = configFileStamp(configFile, projectConfigFilePath(workRoot));
		if (stamp === configStamp) return undefined;
		configStamp = stamp;

		let next: Config;
		try {
			next = readConfigQuietly(options, workRoot, workspaceTrusted);
		} catch (error) {
			// 带上具体原因：配置错误本身带行列信息，丢掉它使用者只能瞎猜改哪儿
			const detail = describeError(error);
			return `Config could not be re-read (${detail}); keeping the previous settings`;
		}

		const diff = diffConfig(activeConfig, next);
		if (diff.live.length === 0 && diff.restart.length === 0) return undefined;
		if (diff.live.length > 0) {
			activeConfig = applyLiveConfig(activeConfig, next, diff.live);
			refreshInfo();
		}

		const applied = diff.live.length === 0 ? [] : [`Config reloaded: ${diff.live.join(", ")}`];
		const pending = diff.restart.length === 0 ? [] : [`restart to apply: ${diff.restart.join(", ")}`];
		return applied.length > 0
			? [...applied, ...pending].join(" · ")
			: `Config changed · ${pending.join(" · ")}`;
	};

	/**
	 * 按当前选中的模型建一次驱动。
	 *
	 * 对话与压缩共用:两者的差别只在最后调 run 还是 compact,装配(选模型、建压缩器、
	 * 接会话与工具)是同一套。
	 */
	const createCurrentDriver = (onEvent: AgentEventListener) => {
		const current = catalog.selection;
		if (current === undefined) throw new Error("No model selected; run /model first");
		const compactor = createCompactor(activeConfig, current);
		return {
			compactor,
			driver: createDriverFor(
				{
					config: activeConfig,
					selection: current,
					compactor,
					contextTokens: lastContextTokens(activeSession.entries()),
					planMode: policy.planMode,
				},
				{
					registry,
					session: activeSession,
					workspace,
					sandbox,
					skills,
					instructions,
					undoNotice: takeUndoNotice,
				},
				onEvent,
			),
		};
	};

	/** 一轮真实对话。模型/思考等级都从当前目录读取，切换后下一轮立即生效。 */
	const runTurn = async (
		prompt: string,
		images: readonly ImageAttachment[],
		onEvent: AgentEventListener,
		signal: AbortSignal,
	): Promise<void> => {
		const reloaded = reloadConfigIfChanged();
		if (reloaded !== undefined) await onEvent({ type: "notice", message: reloaded });

		if (!checkpoints.available) await checkpoints.init();
		const checkpoint = await checkpoints.captureTurn();
		if (checkpoint === undefined && checkpoints.available && checkpoints.lastError !== undefined) {
			await onEvent({
				type: "notice",
				message: `Checkpoint unavailable: ${checkpoints.lastError}`,
			});
		}

		try {
			const { driver } = createCurrentDriver(onEvent);
			const content =
				images.length === 0
					? prompt
					: [
							...(prompt.length > 0 ? [{ type: "text" as const, text: prompt }] : []),
							...images.map(imageBlock),
						];
			await driver.run(content, signal);
		} finally {
			await checkpoints.finalizeTurn(checkpoint?.id);
		}
	};

	/**
	 * 立即压缩上下文。
	 *
	 * 与普通对话走同一条装配路径：压缩模型跟随当前选型，/model 切换后下一次压缩立即用新模型。
	 * 没有上下文上限就无法决定保留多少原文，此时明确拒绝，而不是压出一份不完整的摘要。
	 */
	const compact = async (
		onEvent: AgentEventListener,
		signal: AbortSignal,
	): Promise<void> => {
		const { compactor, driver } = createCurrentDriver(onEvent);
		if (compactor === undefined) {
			throw new Error(
				"No context window is declared for this model; set contextWindow in providers.json or context_window in the config",
			);
		}
		await driver.compact(signal);
	};

	const modelMenu = createModelMenuSource({
		catalog,
		config: activeConfig,
		providersConfig,
		configFile,
		providersFile,
		writePath: configFile,
		onSelection: (next) => {
			footerInfo = createFooterInfo(workRoot, activeConfig, next, activeSession);
		},
		onReady: markSessionReady,
	});
	const effortMenu = createEffortMenuSource({
		getConfig: () => activeConfig,
		writePath: configFile,
		onConfigChange: (next) => {
			activeConfig = next;
			refreshInfo();
		},
	});

	// Shift+Tab 的宿主侧：只动本进程的权限策略，不写配置文件。放宽审批不该因为一次快捷键
	// 就悄悄持久化，重启后回到使用者写定的取值；activeConfig.approval 保持与文件一致，
	// 免得热重载把「会话内的临时切换」误读成「配置文件被改动」。
	const approvalMode = {
		current: () => policy.mode,
		select: (next: ApprovalMode) => {
			policy.setMode(next);
		},
	} satisfies ApprovalModeSource;

	// Plan 与审批正交：它只改本进程的只读闸门，不改配置文件，也不动审批档位。
	const planMode = {
		current: () => policy.planMode,
		select: (enabled: boolean) => {
			policy.setPlanMode(enabled);
		},
	} satisfies PlanModeSource;

	const warning = loaded.ok ? undefined : `Warning: ${loaded.error.message}`;
	const ready = loaded.ok;
	/** /mcps 的一行：server 名单独一列，状态与细节合成说明。 */
	const mcpServerRows = (): readonly { readonly name: string; readonly description: string }[] =>
		(mcpStatus?.() ?? []).map((row) => ({
			name: row.name,
			description: row.detail.length === 0 ? row.status : `${row.status}  ${row.detail}`,
		}));
	// 首帧之前的装配到此为止：后面的菜单数据源只是几个闭包，不花时间
	startup.mark("ready");
	startup.report();

	/** 插件与宿主命令共用一份清单；按需读取，不在装载之后拍成快照。 */
	const pluginCommands = {
		list: () =>
			host.commands().map((command) => ({
				name: command.name,
				description: command.description,
				enabled: true,
			})),
		run: async (name: string, args: string): Promise<readonly string[]> => {
			const lines: string[] = [];
			await host.runCommand(name, args, {
				cwd: workRoot,
				print: (line: string) => lines.push(line),
			});
			return lines;
		},
	};

	/** `/session` 菜单的数据来源；没有会话存储时不提供，命令随之不可用。 */
	const sessionMenu: SessionMenuSource | undefined =
		store === undefined
			? undefined
			: {
					list: () => {
						const active = activeSession.id;
						// 旧版目录里的会话一并列出：目录名规则改过一次，升级后历史不该看起来消失了
						const listings = listSessions(workRoot, store);
						const byId = new Map(listings.map((listing) => [listing.id, listing]));
						return listings.map((listing) => {
							const origin = listing.forkedFrom;
							const originTitle =
								origin === undefined
									? undefined
									: byId.get(origin.session)?.title ?? origin.session.slice(0, 8);
							return {
								id: listing.id,
								title: sessionTitle(listing.title),
								time: sessionAge(listing.updatedAt),
								current: listing.id === active,
								...(originTitle === undefined
									? {}
									: { forkedFrom: sessionTitle(originTitle) }),
							};
						});
					},
					select: (id) => {
						if (id === activeSession.id) return { changed: false, history: [], warnings: [] };

						const switched = openSessionForSwitch(workRoot, id, store);
						adoptSession(switched.session);
						return {
							changed: true,
							history: switched.history,
							todo: switched.todo,
							plan: switched.plan,
							warnings: [],
						};
					},
					fork: (id) => {
						// 分叉只复制对话路径：源会话无论是当前还是历史会话，都从它的当前叶子开始
						let forked: Session;
						if (id === activeSession.id) {
							forked = forkSession(activeSession, workRoot, store);
						} else {
							const listing = listSessions(workRoot, store).find((item) => item.id === id);
							if (listing === undefined) {
								throw new Error(`Session ${id} not found for ${workRoot}`);
							}
							const source = Session.open(listing.file, store);
							try {
								forked = forkSession(source, workRoot, store);
							} finally {
								void source.close().catch(() => {});
							}
						}

						const copied = forked.entryCount;
						const forkedHistory = buildTranscriptHistory(forked.state().messages, workRoot);
						adoptSession(forked);
						return {
							changed: true,
							history: forkedHistory.turns,
							...(forkedHistory.todo === undefined ? {} : { todo: forkedHistory.todo }),
							...(forkedHistory.plan === undefined ? {} : { plan: forkedHistory.plan }),
							warnings: [],
							fork: { sourceId: id, copied },
						};
					},
				};

	try {
		const code = await runTui({
			version: readVersion(),
			info: () => footerInfo,
			warning,
			ready,
			trustPrompt,
			skills: skillsPage,
			mcpServers: mcpStatus === undefined ? undefined : mcpServerRows,
			sessionMenu,
			agent: { runTurn, compact, refreshInfo },
			approval: approvals,
			approvalMode,
			planMode,
			checkpoints: checkpointSource,
			jobs,
			sandbox: {
				info: sandboxInfo,
				...(sandboxWarnings.length === 0 ? {} : { warning: sandboxWarnings.join("\n\n") }),
			},
			images: createImageSource(workRoot),
			imagesSupported: () => catalog.selection?.model.input.includes("image") ?? false,
			clipboard: createClipboardSource(),
			files: {
				list: () =>
					[...fileEntries(workRoot, MAX_FILE_COMPLETION_FILES)].map((entry) => entry.relative),
			},
			modelMenu,
			effortMenu,
			pluginCommands,
			notify: activeConfig.ui.notify,
			history: history.turns,
			historyTodo: history.todo,
			historyPlan: history.plan,
			workspaceRoot: workRoot,
		});
		if (trustDeclined) {
			writeStderr(`reins: workspace not trusted; run again with --trust to use its configuration\n`);
			return 1;
		}
		if (sessionPersisted) writeStdout(`${resumeCommand(activeSession.id)}\n`);
		return code;
	} catch (error) {
		writeStderr(`reins: ${describeError(error)}\n`);
		return 1;
	} finally {
		jobs.shutdown();
		await activeSession.close();
	}
}
