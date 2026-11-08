import { ArrowDown, LoaderCircle } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactElement,
} from "react";

import { api, openEventStream } from "./api.ts";
import { ApprovalCard } from "./chat/approval-card.tsx";
import { Composer, type ComposerProps, type QueuedMessage, sessionReadout } from "./chat/composer.tsx";
import { Hero } from "./chat/hero.tsx";
import { MessageRail } from "./chat/message-rail.tsx";
import { SelectionPopover } from "./chat/selection-popover.tsx";
import { TranscriptView } from "./chat/transcript.tsx";
import { ToastHost, toast } from "./components/ui/index.ts";
import { workspaceName } from "./lib/format.ts";
import { sendDesktopNotification, shouldNotify } from "./lib/notify.ts";
import { desktopBridge } from "./platform.ts";
import { CodePane } from "./panels/code-pane.tsx";
import { FilesPane } from "./panels/files-pane.tsx";
import { GitPane } from "./panels/git-pane.tsx";
import { PluginsPane } from "./panels/plugins-pane.tsx";
import { SchedulesPage } from "./panels/schedules-page.tsx";
import { SidePane } from "./panels/side-pane.tsx";
import { SkillsPane } from "./panels/skills-pane.tsx";
import type { SideTab, SideTabKind } from "./panels/types.ts";
import type {
	ActivitySummary,
	ApprovalAnswer,
	ApprovalMode,
	GitStatus,
	ModelInfo,
	NotifyMode,
	PluginInfo,
	SessionSummary,
	SettingsSnapshot,
	WorkspaceSummary,
	SkillInfo,
	ThinkingLevel,
	UsageSummary,
	WebEvent,
} from "./protocol.ts";
import type { PendingGate } from "./state/approval-shortcut.ts";
import { dispatchEvent } from "./state/session-events.ts";
import { useAppShortcuts } from "./state/use-app-shortcuts.ts";
import { useResponsiveColumns } from "./state/use-responsive-columns.ts";
import { useSelectionQuote } from "./state/use-selection-quote.ts";
import { putSessionTitle, readSessionTitles, withSessionTitles } from "./state/session-titles.ts";
import { SettingsPage, type SettingsSection } from "./settings/settings-page.tsx";
import { AppShell } from "./shell/app-shell.tsx";
import {
	clampRightbar,
	clampSidebar,
	defaultRightbarWidth,
	SIDEBAR_AUTO_COLLAPSE,
	SIDEBAR_DEFAULT,
} from "./shell/columns.ts";
import { CommandPalette } from "./shell/command-palette.tsx";
import { ConversationHeader } from "./shell/conversation-header.tsx";
import type { GlobalPanelId } from "./shell/sidebar.tsx";
import { Sidebar } from "./shell/sidebar.tsx";
import { readPinnedSessions, writePinnedSessions } from "./state/pinned.ts";
import { useTheme } from "./state/theme.ts";
import { linesFromEntries, type Line } from "./transcript/lines.ts";

const STICK_THRESHOLD = 80;

interface SessionTarget {
	readonly id: string;
	readonly cwd: string;
	readonly workspacePath?: string | null;
}

/** 界面主组件：装配三栏骨架、会话状态与事件流。 */
export function App(): ReactElement {
	const theme = useTheme();
	const [lines, setLines] = useState<readonly Line[]>([]);
	const [running, setRunning] = useState(false);
	const [awaitingModel, setAwaitingModel] = useState(false);
	const [approval, setApproval] = useState<PendingGate | undefined>(undefined);
	const [deferred, setDeferred] = useState(false);
	const [connected, setConnected] = useState(false);
	const [sessionId, setSessionId] = useState("");
	const [cwd, setCwd] = useState("");
	const [currentWorkspacePath, setCurrentWorkspacePath] = useState<string | null | undefined>(undefined);
	const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
	const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
	const [archived, setArchived] = useState<readonly SessionSummary[]>([]);
	const [sessionTitles, setSessionTitles] = useState(readSessionTitles);
	const [settings, setSettings] = useState<SettingsSnapshot | undefined>(undefined);
	const [model, setModel] = useState<ModelInfo>({ provider: "", model: "", name: "" });
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
	const [planMode, setPlanMode] = useState(false);
	const [effort, setEffort] = useState<ThinkingLevel>("off");
	const [contextWindow, setContextWindow] = useState<number | undefined>(undefined);
	const [contextTokens, setContextTokens] = useState<number | undefined>(undefined);
	const [usage, setUsage] = useState<UsageSummary>({
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: undefined,
	});
	const [activity, setActivity] = useState<ActivitySummary>({
		turns: 0,
		steps: 0,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftCount: 0,
		decodeTokens: 0,
		decodeMs: 0,
	});
	const [git, setGit] = useState<GitStatus | null>(null);
	const [skills, setSkills] = useState<readonly SkillInfo[]>([]);
	const [plugins, setPlugins] = useState<readonly PluginInfo[]>([]);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < SIDEBAR_AUTO_COLLAPSE);
	const [autoCollapsed, setAutoCollapsed] = useState(window.innerWidth < SIDEBAR_AUTO_COLLAPSE);
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const [sideTabs, setSideTabs] = useState<readonly SideTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
	const [sideOpen, setSideOpen] = useState(false);
	const [sideFullscreen, setSideFullscreen] = useState(false);
	const [sideWidth, setSideWidth] = useState(() => defaultRightbarWidth(window.innerWidth));
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
	const [searchOpen, setSearchOpen] = useState(false);
	const [commandOpen, setCommandOpen] = useState(false);
	const [activePanel, setActivePanel] = useState<GlobalPanelId | undefined>(undefined);
	const [pinned, setPinned] = useState<ReadonlySet<string>>(readPinnedSessions);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [atBottom, setAtBottom] = useState(true);
	const [queue, setQueue] = useState<readonly QueuedMessage[]>([]);
	const [quote, setQuote] = useState<string | undefined>(undefined);

	const stickToBottom = useRef(true);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const { selection, clear: clearSelection } = useSelectionQuote(scrollRef);
	const everConnected = useRef(false);
	const historyRef = useRef<SessionTarget[]>([]);
	const historyIndexRef = useRef(-1);
	const navigatingRef = useRef(false);
	const notifyModeRef = useRef<NotifyMode>("auto");
	const runOutcomeRef = useRef<"running" | "done" | "error" | "aborted">("done");
	const errorNotifiedRef = useRef(false);
	const approvalNotifiedRef = useRef<number | undefined>(undefined);

	const refreshSessions = useCallback((): void => {
		void api.sessions().then(setSessions).catch(() => {});
		void api.archivedSessions().then(setArchived).catch(() => {});
		void api.workspaces().then(setWorkspaces).catch(() => {});
	}, []);

	const refreshSettings = useCallback((): void => {
		void api
			.settings()
			.then((snapshot) => {
				setSettings(snapshot);
				setSkills(snapshot.skills);
				setPlugins(snapshot.plugins);
				setEffort(snapshot.effort);
				setApprovalMode(snapshot.approval);
				setContextWindow(snapshot.contextWindow);
				const current = snapshot.models.find(
					(item) => item.provider === snapshot.provider && item.model === snapshot.model,
				);
				setModel({ provider: snapshot.provider, model: snapshot.model, name: current?.name ?? snapshot.model });
			})
			.catch(() => {});
	}, []);

	const openSettings = useCallback((section: SettingsSection): void => {
		setSettingsSection(section);
		setSettingsOpen(true);
	}, []);

	useEffect(() => {
		notifyModeRef.current = settings?.notify ?? "auto";
	}, [settings?.notify]);

	const refreshGit = useCallback((): void => {
		void api.gitStatus().then(setGit).catch(() => setGit(null));
	}, []);

	const updateHistoryButtons = useCallback((): void => {
		setCanGoBack(historyIndexRef.current > 0);
		setCanGoForward(historyIndexRef.current < historyRef.current.length - 1);
	}, []);

	/** 跨项目打开任务时由桌面壳换服务进程；同一工作区内复用当前服务。 */
	const openSessionTarget = useCallback(
		(target: SessionTarget): void => {
			if (running && (target.workspacePath ?? target.cwd) !== cwd) {
				toast("当前任务运行中，完成后才能切换项目", "info");
				return;
			}
			setActivePanel(undefined);
			setSideFullscreen(false);
			if (target.id === sessionId) return;
			setSettingsOpen(false);
			const targetRoot = target.workspacePath ?? target.cwd;
			if (targetRoot === cwd) {
				void api.switchSession(target.id).catch((error: unknown) => {
					toast(error instanceof Error ? error.message : String(error), "error");
				});
				return;
			}
			const bridge = desktopBridge();
			if (bridge === undefined) {
				toast("此任务属于其他项目，请在桌面端打开", "error");
				return;
			}
			void bridge
				.openSession(target.workspacePath ?? null, target.cwd, target.id)
				.then((opened) => {
					if (!opened) toast("无法打开此任务所在的项目", "error");
				})
				.catch((error: unknown) => {
					toast(error instanceof Error ? error.message : String(error), "error");
				});
		},
		[cwd, running, sessionId],
	);

	/** 会话切换后记一笔浏览历史；草稿不入栈。 */
	const rememberSession = useCallback(
		(target: SessionTarget, draft: boolean): void => {
			if (target.id.length === 0) return;
			if (navigatingRef.current) {
				navigatingRef.current = false;
				updateHistoryButtons();
				return;
			}
			if (draft) return;
			const history = historyRef.current;
			if (history.length === 0) {
				historyRef.current = [target];
				historyIndexRef.current = 0;
			} else if (history[historyIndexRef.current]?.id !== target.id) {
				const next = [...history.slice(0, historyIndexRef.current + 1), target];
				historyRef.current = next;
				historyIndexRef.current = next.length - 1;
			}
			updateHistoryButtons();
		},
		[updateHistoryButtons],
	);

	const goBack = useCallback((): void => {
		if (historyIndexRef.current <= 0) return;
		historyIndexRef.current -= 1;
		const target = historyRef.current[historyIndexRef.current];
		if (target === undefined) return;
		navigatingRef.current = true;
		updateHistoryButtons();
		openSessionTarget(target);
	}, [openSessionTarget, updateHistoryButtons]);

	const goForward = useCallback((): void => {
		if (historyIndexRef.current >= historyRef.current.length - 1) return;
		historyIndexRef.current += 1;
		const target = historyRef.current[historyIndexRef.current];
		if (target === undefined) return;
		navigatingRef.current = true;
		updateHistoryButtons();
		openSessionTarget(target);
	}, [openSessionTarget, updateHistoryButtons]);

	const reload = useCallback((): void => {
		stickToBottom.current = true;
		void (async () => {
			try {
				const [state, session] = await Promise.all([api.state(), api.session()]);
				setRunning(state.running);
				setAwaitingModel(state.running && state.approval === undefined);
				setApproval(state.approval === undefined ? undefined : { id: state.approval.id, request: state.approval.request });
				setApprovalMode(state.approvalMode);
				setPlanMode(state.planMode);
				setEffort(state.effort);
				setModel(state.model);
				setSessionId(state.sessionId);
				rememberSession(
					{ id: session.id, cwd: session.cwd, workspacePath: session.workspacePath },
					session.entries.length === 0,
				);
				setCwd(state.cwd);
				setCurrentWorkspacePath(session.workspacePath);
				setContextWindow(state.contextWindow);
				setContextTokens(state.contextTokens);
				setUsage(state.usage);
				setActivity(state.activity);
				setLines(linesFromEntries(session.entries));
				setLoadError(undefined);
			} catch (error) {
				setLoadError(error instanceof Error ? error.message : String(error));
			}
		})();
	}, [rememberSession]);

	const maybeNotify = useCallback((title: string, body: string): void => {
		if (!shouldNotify(notifyModeRef.current, document.hasFocus())) return;
		sendDesktopNotification(title, body);
	}, []);

	const handleEvent = useCallback(
		(event: WebEvent): void => {
			dispatchEvent(event, {
				outcome: runOutcomeRef,
				errorNotified: errorNotifiedRef,
				approvalNotified: approvalNotifiedRef,
				setLines, setRunning, setAwaitingModel, setDeferred, setApproval,
				setActivity, setUsage, setContextTokens, setQueue, setActivePanel, setSideFullscreen,
				maybeNotify, reload, refreshSessions, refreshSettings, refreshGit,
			});
		},
		[maybeNotify, reload, refreshGit, refreshSessions, refreshSettings],
	);

	useEffect(() => {
		let dispose: (() => void) | undefined;
		void (async () => {
			reload();
			refreshSessions();
			refreshSettings();
			refreshGit();
			dispose = openEventStream(handleEvent, setConnected);
		})();
		return () => dispose?.();
	}, [handleEvent, refreshGit, refreshSessions, refreshSettings, reload]);

	useEffect(() => {
		if (connected) everConnected.current = true;
	}, [connected]);

	// 断线重连后整份重放：EventSource 只负责重连，断线期间的事件不会补发
	const wasConnected = useRef(false);
	useEffect(() => {
		if (connected && wasConnected.current) {
			reload();
			refreshSessions();
			refreshSettings();
			refreshGit();
		}
		if (connected) wasConnected.current = true;
	}, [connected, refreshGit, refreshSessions, refreshSettings, reload]);

	useEffect(() => {
		if (!stickToBottom.current) return;
		const element = scrollRef.current;
		if (element !== null) element.scrollTop = element.scrollHeight;
	}, [lines, approval, awaitingModel]);

	useEffect(() => {
		const timer = window.setInterval(() => {
			if (!running) refreshGit();
		}, 10_000);
		return () => window.clearInterval(timer);
	}, [running, refreshGit]);

	useResponsiveColumns({
		sidebarCollapsed, sidebarWidth, sideOpen, autoCollapsed,
		onSidebarCollapsed: setSidebarCollapsed, onAutoCollapsed: setAutoCollapsed,
		onSideOpen: setSideOpen, onSideFullscreen: setSideFullscreen,
	});

	const toggleSidebar = useCallback((): void => {
		setAutoCollapsed(false);
		setSidebarCollapsed((value) => !value);
	}, []);

	const openSearch = useCallback((): void => {
		setAutoCollapsed(false);
		setSidebarCollapsed(false);
		setSearchOpen(true);
	}, []);

	const onScroll = useCallback((): void => {
		const element = scrollRef.current;
		if (element === null) return;
		const near = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD;
		stickToBottom.current = near;
		setAtBottom((current) => (current === near ? current : near));
	}, []);

	const jumpToBottom = useCallback((): void => {
		const element = scrollRef.current;
		if (element === null) return;
		stickToBottom.current = true;
		setAtBottom(true);
		element.scrollTop = element.scrollHeight;
	}, []);

	const newTask = useCallback(
		(workspacePath: string | null = null): void => {
			if (running && workspacePath !== null && workspacePath !== cwd) {
				toast("当前任务运行中，完成后才能新建其他项目的任务", "info");
				return;
			}
			setSettingsOpen(false);
			setActivePanel(undefined);
			setSideFullscreen(false);
			if (workspacePath === null || workspacePath === cwd) {
				void api.newSession(workspacePath).catch((error: unknown) => {
					toast(error instanceof Error ? error.message : String(error), "error");
				});
				return;
			}
			const bridge = desktopBridge();
			if (bridge === undefined) {
				toast("只能在当前项目创建任务", "error");
				return;
			}
			void bridge
				.newTaskInWorkspace(workspacePath)
				.then((created) => {
					if (!created) toast("无法在此项目中新建任务", "error");
				})
				.catch((error: unknown) => {
					toast(error instanceof Error ? error.message : String(error), "error");
				});
		},
		[cwd, running],
	);

	const togglePin = useCallback((id: string): void => {
		setPinned((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			writePinnedSessions(next);
			return next;
		});
	}, []);

	const renameSession = useCallback((id: string, title: string): void => {
		setSessionTitles((current) => putSessionTitle(current, id, title));
	}, []);

	const renameWorkspace = useCallback((path: string, name: string): void => {
		setWorkspaces((current) =>
			current.map((workspace) => (workspace.path === path ? { ...workspace, name } : workspace)),
		);
	}, []);

	/**
	 * 删除项目：连同它名下的任务一起永久删除，动作在内核里完成。
	 *
	 * 删完一律按服务端结果刷新而不是本地剔除——回合正跑着的时候内核会拒绝，此时项目必须
	 * 还留在列表里，本地先删就等于骗使用者说删掉了。
	 */
	const removeWorkspace = useCallback(
		(path: string): void => {
			if (running) {
				toast("当前任务运行中，完成后才能删除项目", "info");
				return;
			}
			void api
				.deleteWorkspace(path)
				.then(refreshSessions)
				.catch((error: unknown) => {
					toast(error instanceof Error ? error.message : String(error), "error");
				});
		},
		[refreshSessions, running],
	);

	const switchSession = useCallback(
		(session: SessionSummary): void => {
			openSessionTarget({
				id: session.id,
				cwd: session.cwd ?? cwd,
				workspacePath: session.workspacePath,
			});
		},
		[cwd, openSessionTarget],
	);

	/** 发送一条消息：运行中则入队，空闲则直接发出。 */
	const deliver = useCallback(
		(text: string): void => {
			setActivePanel(undefined);
			setSideFullscreen(false);
			setLines((current) => [...current, { kind: "user", text }]);
			void api.send(text).catch((error: unknown) => {
				setLines((current) => [
					...current,
					{ kind: "notice", text: error instanceof Error ? error.message : String(error), tone: "error" },
				]);
			});
			refreshSessions();
			setActivity((current) => ({ ...current, turns: current.turns + 1 }));
		},
		[refreshSessions],
	);

	const send = useCallback(
		(text: string): void => {
			if (running) {
				// 回合进行中按 Enter 不丢消息也不打断：进排队条，回合结束后依次发出
				setQueue((current) => [...current, { id: `q-${Date.now()}-${current.length}`, text }]);
				return;
			}
			deliver(text);
		},
		[deliver, running],
	);

	// 回合结束后把队列里的下一条发出去
	const lastRunning = useRef(running);
	useEffect(() => {
		if (lastRunning.current && !running && queue.length > 0) {
			const next = queue[0];
			setQueue((current) => current.slice(1));
			if (next !== undefined) deliver(next.text);
		}
		lastRunning.current = running;
	}, [running, queue, deliver]);

	const stop = useCallback((): void => {
		void api.abort().catch(() => {});
	}, []);

	const answer = useCallback((id: number, value: ApprovalAnswer): void => {
		setApproval(undefined);
		setDeferred(false);
		void api.approve(id, value).catch((error: unknown) => {
			toast(error instanceof Error ? error.message : String(error), "error");
		});
	}, []);

	const changeApprovalMode = useCallback((mode: ApprovalMode): void => {
		setApprovalMode(mode);
		void api.setApprovalMode(mode).catch((error: unknown) => {
			toast(error instanceof Error ? error.message : String(error), "error");
		});
	}, []);

	const changePlanMode = useCallback((enabled: boolean): void => {
		setPlanMode(enabled);
		void api.setPlanMode(enabled).catch((error: unknown) => {
			toast(error instanceof Error ? error.message : String(error), "error");
		});
	}, []);

	const changeModel = useCallback((provider: string, modelId: string): void => {
		void api
			.setModel(provider, modelId)
			.then(() => api.settings())
			.then((snapshot) => {
				setSettings(snapshot);
				setContextWindow(snapshot.contextWindow);
				const current = snapshot.models.find(
					(item) => item.provider === snapshot.provider && item.model === snapshot.model,
				);
				setModel({ provider: snapshot.provider, model: snapshot.model, name: current?.name ?? snapshot.model });
			})
			.catch((error: unknown) => {
				toast(error instanceof Error ? error.message : String(error), "error");
			});
	}, []);

	const changeEffort = useCallback((level: ThinkingLevel): void => {
		setEffort(level);
		void api
			.updateSettings({ effort: level })
			.then((snapshot) => setSettings(snapshot))
			.catch((error: unknown) => {
				toast(error instanceof Error ? error.message : String(error), "error");
			});
	}, []);

	const updateSettings = useCallback(
		(update: { effort?: ThinkingLevel; approval?: ApprovalMode; notify?: NotifyMode }): void => {
			void api
				.updateSettings(update)
				.then((snapshot) => {
					setSettings(snapshot);
					setEffort(snapshot.effort);
					setApprovalMode(snapshot.approval);
				})
				.catch((error: unknown) => {
					toast(error instanceof Error ? error.message : String(error), "error");
				});
		},
		[],
	);

	const openTab = useCallback((tab: SideTab): void => {
		setSideTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
		setActiveTabId(tab.id);
		setSideOpen(true);
	}, []);

	const openFile = useCallback(
		(path: string): void => {
			const name = path.split(/[\\/]/).pop() ?? path;
			openTab({ id: `code:${path}`, kind: "code", title: name, path });
		},
		[openTab],
	);

	const addSideTab = useCallback(
		(kind: SideTabKind): void => {
			if (kind === "files") openTab({ id: "files", kind: "files", title: "文件" });
			else if (kind === "git") openTab({ id: "git", kind: "git", title: "Git" });
			else if (kind === "skills") openTab({ id: "skills", kind: "skills", title: "技能" });
			else if (kind === "plugins") openTab({ id: "plugins", kind: "plugins", title: "插件" });
			else if (kind === "browser") openTab({ id: "browser", kind: "browser", title: "浏览器" });
			else openTab({ id: "terminal", kind: "terminal", title: "终端" });
		},
		[openTab],
	);

	const closeTab = useCallback((id: string): void => {
		setSideTabs((current) => {
			const next = current.filter((item) => item.id !== id);
			setActiveTabId((active) => (active === id ? next[next.length - 1]?.id : active));
			return next;
		});
	}, []);

	const toggleSidePane = useCallback((): void => {
		if (sideOpen) {
			setSideOpen(false);
			setSideFullscreen(false);
			return;
		}
		setSideOpen(true);
	}, [sideOpen]);


	const thinkingLevels = useMemo(
		() => settings?.models.find((item) => item.model === model.model)?.thinkingLevels ?? [],
		[settings?.models, model.model],
	);
	const openGeneralSettings = useCallback((): void => openSettings("general"), [openSettings]);
	const toggleCommandPalette = useCallback((): void => setCommandOpen((value) => !value), []);
	useAppShortcuts({
		settingsOpen, running, approval, effort, thinkingLevels,
		onSettings: openGeneralSettings, onToggleSidebar: toggleSidebar,
		onToggleCommand: toggleCommandPalette, onNewTask: newTask,
		onEffort: changeEffort, onStop: stop, onAnswer: answer,
	});

	const activeTab = sideTabs.find((tab) => tab.id === activeTabId);
	const connectionOk = connected || !everConnected.current;

	const composerProps: ComposerProps = {
		running,
		approvalMode,
		planMode,
		effort,
		model,
		models: settings?.models ?? [],
		skills,
		mcpServers: settings?.mcpServers ?? [],
		workspaceName: workspaceName(cwd),
		workspacePath: currentWorkspacePath ?? "",
		branch: git?.branch,
		contextTokens,
		contextWindow,
		usage,
		activity,
		queue,
		quote,
		onSend: send,
		onStop: stop,
		onApprovalMode: changeApprovalMode,
		onPlanMode: changePlanMode,
		onModel: changeModel,
		onEffort: changeEffort,
		onNewTask: newTask,
		onOpenSettings: () => openSettings("general"),
		onCompact: () => {
			void api.compact().catch((error: unknown) => {
				toast(error instanceof Error ? error.message : String(error), "error");
			});
		},
		onQueueRemove: (id) => setQueue((current) => current.filter((item) => item.id !== id)),
		onQueueEdit: (id, text) =>
			setQueue((current) => current.map((item) => (item.id === id ? { ...item, text } : item))),
		onQueueSendNow: (id) => {
			const target = queue.find((item) => item.id === id);
			if (target === undefined) return;
			setQueue((current) => current.filter((item) => item.id !== id));
			void api.abort().catch(() => {});
			window.setTimeout(() => deliver(target.text), 120);
		},
		onQueueReorder: (from, to) =>
			setQueue((current) => {
				const next = [...current];
				const [moved] = next.splice(from, 1);
				if (moved === undefined) return current;
				next.splice(to, 0, moved);
				return next;
			}),
		onQuoteConsumed: () => setQuote(undefined),
	};

	const draft = lines.length === 0 && !running && activePanel === undefined;
	const displaySessions = useMemo(() => withSessionTitles(sessions, sessionTitles), [sessions, sessionTitles]);
	const currentTitle = displaySessions.find((session) => session.id === sessionId)?.title ?? "新任务";
	const readout = sessionReadout(usage, activity);

	useEffect(() => {
		document.title = currentTitle === "新任务" ? "Reins" : `${currentTitle} · Reins`;
	}, [currentTitle]);

	const sidePane = (
		<SidePane
			tabs={sideTabs}
			activeId={activeTabId}
			fullscreen={sideFullscreen}
			onSelect={setActiveTabId}
			onClose={closeTab}
			onClosePane={() => {
				setSideOpen(false);
				setSideFullscreen(false);
			}}
			onToggleFullscreen={() => setSideFullscreen((value) => !value)}
			onAdd={addSideTab}
		>
			{activeTab?.kind === "files" ? <FilesPane git={git} onOpenFile={openFile} /> : null}
			{activeTab?.kind === "code" ? <CodePane path={activeTab.path} /> : null}
			{activeTab?.kind === "git" ? (
				<GitPane status={git} onRefresh={refreshGit} onOpenFile={openFile} />
			) : null}
			{activeTab?.kind === "skills" ? <SkillsPane skills={skills} /> : null}
			{activeTab?.kind === "plugins" ? <PluginsPane plugins={plugins} /> : null}
		</SidePane>
	);

	const main = activePanel === "schedules" ? (
		<SchedulesPage onClose={() => setActivePanel(undefined)} />
	) : (
		<>
			{draft ? null : (
				<ConversationHeader
					title={currentTitle}
					workspace={workspaceName(cwd)}
					meta={readout}
					rightbarOpen={sideOpen}
					onToggleRightbar={toggleSidePane}
					onArchive={() => {
						void api.archiveSessions([sessionId]).then(refreshSessions).catch(() => {});
					}}
					onReveal={() => desktopBridge()?.openWorkspaceFolder(currentWorkspacePath ?? cwd)}
				/>
			)}

			{loadError !== undefined ? (
				<div className="flex flex-1 items-center justify-center px-6 text-[var(--fs-13)]" style={{ color: "var(--danger)" }}>
					无法连接：{loadError}
				</div>
			) : draft ? (
				<Hero
					composer={<Composer {...composerProps} blank />}
					onStart={(text) => deliver(text)}
					rightbarOpen={sideOpen}
					onToggleRightbar={toggleSidePane}
				/>
			) : (
				<>
					<div className="transcript-wrap">
						<div className="transcript" ref={scrollRef} onScroll={onScroll}>
							<TranscriptView
								lines={lines}
								running={running}
								onRegenerate={(text) => deliver(text)}
							/>
							{awaitingModel ? (
								<div className="flow" style={{ paddingTop: 0 }}>
									<div className="flex items-center gap-2 py-1">
										<span className="pixel-load" aria-label="正在思考">
											<i />
											<i />
											<i />
											<i />
										</span>
										<span className="sweep-text text-[var(--fs-11)]" style={{ color: "var(--ink-3)" }}>
											正在思考
										</span>
									</div>
								</div>
							) : null}
						</div>

						{!atBottom ? (
							<button type="button" className="back-latest" onClick={jumpToBottom}>
								<ArrowDown className="ic-12" />
								回到最新
							</button>
						) : null}

						<MessageRail lines={lines} scrollRef={scrollRef} />
					</div>

					<div className="dock">
						<div className="dock-in">
							{/* 待办槽位：模型在等回答时，输入卡整块让位给这张卡；答完换回 */}
							{approval === undefined || deferred ? null : (
								<ApprovalCard
									request={approval.request}
									count="1 / 1"
									onDefer={() => setDeferred(true)}
									onAnswer={(value) => answer(approval.id, value)}
								/>
							)}
							{deferred && approval !== undefined ? (
								<button
									type="button"
									className="gate"
									style={{ width: "100%", textAlign: "left" }}
									onClick={() => setDeferred(false)}
								>
									<div className="gate-h" style={{ borderBottom: 0 }}>
										<span className="mk">
											<LoaderCircle className="ic-12" />
										</span>
										<span className="t">有一条请求待确认</span>
										<span className="cnt">展开</span>
									</div>
								</button>
							) : null}
							<Composer {...composerProps} />
						</div>
					</div>
				</>
			)}
		</>
	);

	return (
		<>
			{connectionOk ? null : <div className="conn-banner" role="status" aria-label="连接已断开，正在重连" />}

			<AppShell
				inactive={settingsOpen}
				sidebarWidth={sidebarWidth}
				sidebarCollapsed={sidebarCollapsed}
				rightbarWidth={sideWidth}
				rightbarOpen={sideOpen}
				rightbarFullscreen={sideFullscreen}
				workspace={draft ? "" : workspaceName(cwd)}
				title={draft ? "新任务" : currentTitle}
				onSidebarWidth={(width) => setSidebarWidth(clampSidebar(width))}
				onRightbarWidth={(width) => setSideWidth(clampRightbar(width, window.innerWidth))}
				onToggleSidebar={toggleSidebar}
				onOpenSearch={openSearch}
				canGoBack={canGoBack}
				canGoForward={canGoForward}
				onBack={goBack}
				onForward={goForward}
				sidebar={
					<Sidebar
						sessions={displaySessions}
						pinned={pinned}
						currentId={sessionId}
						currentIsDraft={lines.length === 0}
						currentWorkspacePath={currentWorkspacePath}
						running={running}
						waiting={approval !== undefined}
						cwd={cwd}
						workspaces={workspaces}
						version={settings?.version ?? ""}
						connected={connectionOk}
						activePanel={activePanel}
						searchOpen={searchOpen}
						onSearchOpenChange={setSearchOpen}
						onNewSession={newTask}
						onSwitch={switchSession}
						onArchive={(id) => {
							void api.archiveSessions([id]).then(refreshSessions).catch(() => {});
						}}
						onDelete={(id) => {
							void api.deleteSessions([id]).then(refreshSessions).catch(() => {});
						}}
						onTogglePin={togglePin}
						onOpenPanel={(panel) => {
							setActivePanel(panel);
							setSettingsOpen(false);
							setSideFullscreen(false);
						}}
						onOpenExtensions={() => openSettings("extensions")}
						onOpenSettings={() => openSettings("general")}
						onRenameWorkspace={renameWorkspace}
						onRemoveWorkspace={removeWorkspace}
						onRenameSession={renameSession}
					/>
				}
				rightbar={sidePane}
			>
				{main}
			</AppShell>

			{selection === undefined ? null : (
				<SelectionPopover anchor={selection} onQuote={setQuote} onClose={clearSelection} />
			)}

			<ToastHost />
			{settingsOpen ? (
				<SettingsPage
					settings={settings}
					archived={archived}
					usage={usage}
					activity={activity}
					themeMode={theme.mode}
					initialSection={settingsSection}
					onThemeMode={theme.setMode}
					onClose={() => setSettingsOpen(false)}
					onUpdate={updateSettings}
					onModel={changeModel}
					onRefresh={refreshSettings}
					onRestore={(id) => {
						void api.restoreSessions([id]).then(refreshSessions).catch(() => {});
					}}
					onDeleteArchived={(id) => {
						void api.deleteSessions([id]).then(refreshSessions).catch(() => {});
					}}
				/>
			) : null}
			<CommandPalette
				open={commandOpen}
				sessions={displaySessions}
				onClose={() => setCommandOpen(false)}
				onNewTask={() => {
					setCommandOpen(false);
					newTask();
				}}
				onSettings={() => {
					setCommandOpen(false);
					openSettings("general");
				}}
				onToggleTheme={theme.toggle}
				onToggleSidePane={toggleSidePane}
				onCompact={() => {
					setCommandOpen(false);
					void api.compact().catch((error: unknown) => {
						toast(error instanceof Error ? error.message : String(error), "error");
					});
				}}
				onSwitchSession={switchSession}
				onOpenFile={openFile}
			/>
		</>
	);
}
