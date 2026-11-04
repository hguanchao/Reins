import { ArrowDown } from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactElement,
} from "react";

import { api, openEventStream } from "./api.ts";
import { ApprovalCard } from "./chat/approval-card.tsx";
import { Composer, type ComposerProps } from "./chat/composer.tsx";
import { Hero } from "./chat/hero.tsx";
import { LoadingPixels } from "./chat/loading-pixels.tsx";
import { MessageRail } from "./chat/message-rail.tsx";
import { TranscriptView } from "./chat/transcript.tsx";
import { ToastHost, toast } from "./components/ui/index.ts";import { ScrollFadeViewport } from "./components/ui/scroll-fade-viewport.tsx";
import { workspaceName } from "./lib/format.ts";
import { CodePane } from "./panels/code-pane.tsx";
import { FilesPane } from "./panels/files-pane.tsx";
import { GitPane } from "./panels/git-pane.tsx";
import { PluginsPage } from "./panels/plugins-page.tsx";
import { PluginsPane } from "./panels/plugins-pane.tsx";
import { SchedulesPage } from "./panels/schedules-page.tsx";
import { SidePane } from "./panels/side-pane.tsx";
import { SkillsPane } from "./panels/skills-pane.tsx";
import type { SideTab, SideTabKind } from "./panels/types.ts";
import type {
	ApprovalAnswer,
	ApprovalMode,
	ApprovalRequest,
	GitStatus,
	ModelInfo,
	PluginInfo,
	SessionSummary,
	SettingsSnapshot,
	SkillInfo,
	ThinkingLevel,
	ActivitySummary,
	UsageSummary,
	WebEvent,
} from "./protocol.ts";
import { applyActivityRecorded, applyToolDuration, applyUsageRecorded } from "./state/usage.ts";
import { SettingsPage } from "./settings/settings-page.tsx";
import { AppShell } from "./shell/app-shell.tsx";
import {
	autoSidebarAction,
	clampSidebar,
	defaultRightbarWidth,
	RIGHTBAR_MAX_RATIO,
	RIGHTBAR_MIN,
	SIDEBAR_AUTO_COLLAPSE,
} from "./shell/columns.ts";
import { CommandPalette } from "./shell/command-palette.tsx";
import { ConversationHeader } from "./shell/conversation-header.tsx";
import type { GlobalPanelId } from "./shell/sidebar.tsx";
import { Sidebar } from "./shell/sidebar.tsx";
import { readPinnedSessions, writePinnedSessions } from "./state/pinned.ts";
import { useTheme } from "./state/theme.ts";
import { appendToLast, linesFromEntries, sealStreaming, updateTool, type Line } from "./transcript/lines.ts";

const STICK_THRESHOLD = 80;
const SIDEBAR_DEFAULT = 280;

/** 界面主组件：装配三栏骨架、会话状态与事件流。 */
export function App(): ReactElement {
	const theme = useTheme();
	const [lines, setLines] = useState<readonly Line[]>([]);
	const [running, setRunning] = useState(false);
	const [awaitingModel, setAwaitingModel] = useState(false);
	const [approval, setApproval] = useState<{ id: number; request: ApprovalRequest } | undefined>(undefined);
	const [connected, setConnected] = useState(false);
	const [sessionId, setSessionId] = useState("");
	const [cwd, setCwd] = useState("");
	const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
	const [archived, setArchived] = useState<readonly SessionSummary[]>([]);
	const [settings, setSettings] = useState<SettingsSnapshot | undefined>(undefined);
	const [model, setModel] = useState<ModelInfo>({ provider: "", model: "", name: "" });
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
	const [planMode, setPlanMode] = useState(false);
	const [effort, setEffort] = useState<ThinkingLevel>("off");
	const [contextWindow, setContextWindow] = useState<number | undefined>(undefined);
	const [contextTokens, setContextTokens] = useState<number | undefined>(undefined);
	const [usage, setUsage] = useState<UsageSummary>({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: undefined });
	const [activity, setActivity] = useState<ActivitySummary>({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftCount: 0, decodeTokens: 0, decodeMs: 0 });
	const [git, setGit] = useState<GitStatus | null>(null);
	const [skills, setSkills] = useState<readonly SkillInfo[]>([]);
	const [plugins, setPlugins] = useState<readonly PluginInfo[]>([]);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < SIDEBAR_AUTO_COLLAPSE);
	// 记住这次收起是不是窄窗自动做的：变宽后要还回去；用户亲手收起的另当别论
	const [autoCollapsed, setAutoCollapsed] = useState(window.innerWidth < SIDEBAR_AUTO_COLLAPSE);
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const [sideTabs, setSideTabs] = useState<readonly SideTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
	const [sideOpen, setSideOpen] = useState(false);
	const [sideFullscreen, setSideFullscreen] = useState(false);
	const [sideWidth, setSideWidth] = useState(() => defaultRightbarWidth(window.innerWidth));
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [commandOpen, setCommandOpen] = useState(false);
	const [activePanel, setActivePanel] = useState<GlobalPanelId | undefined>(undefined);
	const [pinned, setPinned] = useState<ReadonlySet<string>>(readPinnedSessions);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [atBottom, setAtBottom] = useState(true);
	const stickToBottom = useRef(true);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const everConnected = useRef(false);
	const historyRef = useRef<string[]>([]);
	const historyIndexRef = useRef(-1);
	const navigatingRef = useRef(false);

	const refreshSessions = useCallback((): void => {
		void api.sessions().then(setSessions).catch(() => {});
		void api.archivedSessions().then(setArchived).catch(() => {});
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

	const refreshGit = useCallback((): void => {
		void api.gitStatus().then(setGit).catch(() => setGit(null));
	}, []);

	const updateHistoryButtons = useCallback((): void => {
		setCanGoBack(historyIndexRef.current > 0);
		setCanGoForward(historyIndexRef.current < historyRef.current.length - 1);
	}, []);

	/** 会话切换后记一笔浏览历史；后退/前进自己触发的切换不重复入栈，草稿会话不入栈。 */
	const rememberSession = useCallback(
		(id: string, draft: boolean): void => {
			if (id.length === 0) return;
			if (navigatingRef.current) {
				navigatingRef.current = false;
				updateHistoryButtons();
				return;
			}
			// 草稿还没落在磁盘上，后退回来只会撞上「会话不存在」；想回到空白页再点一次新会话即可
			if (draft) return;
			const history = historyRef.current;
			if (history.length === 0) {
				historyRef.current = [id];
				historyIndexRef.current = 0;
			} else if (history[historyIndexRef.current] !== id) {
				const next = [...history.slice(0, historyIndexRef.current + 1), id];
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
		const id = historyRef.current[historyIndexRef.current];
		if (id === undefined) return;
		navigatingRef.current = true;
		updateHistoryButtons();
		setActivePanel(undefined);
		setSideFullscreen(false);
		void api.switchSession(id).catch((error: unknown) => {
			navigatingRef.current = false;
			toast(error instanceof Error ? error.message : String(error), "error");
		});
	}, [updateHistoryButtons]);

	const goForward = useCallback((): void => {
		if (historyIndexRef.current >= historyRef.current.length - 1) return;
		historyIndexRef.current += 1;
		const id = historyRef.current[historyIndexRef.current];
		if (id === undefined) return;
		navigatingRef.current = true;
		updateHistoryButtons();
		setActivePanel(undefined);
		setSideFullscreen(false);
		void api.switchSession(id).catch((error: unknown) => {
			navigatingRef.current = false;
			toast(error instanceof Error ? error.message : String(error), "error");
		});
	}, [updateHistoryButtons]);

	const reload = useCallback((): void => {
		stickToBottom.current = true;
		void (async () => {
			try {
				const [state, session] = await Promise.all([api.state(), api.session()]);
				setRunning(state.running);
				setAwaitingModel(state.running && state.approval === undefined);
				setApproval(state.approval);
				setApprovalMode(state.approvalMode);
				setPlanMode(state.planMode);
				setEffort(state.effort);
				setModel(state.model);
				setSessionId(state.sessionId);
				rememberSession(state.sessionId, session.entries.length === 0);
				setCwd(state.cwd);
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

	const handleEvent = useCallback(
		(event: WebEvent): void => {
			switch (event.type) {
				case "turn_start":
					setLines(sealStreaming);
					setRunning(true);
					setAwaitingModel(true);
					return;
				case "writing_tool_call":
					setAwaitingModel(false);
					return;
				case "text_delta":
					setAwaitingModel(false);
					setLines((current) => appendToLast(current, "assistant", event.text));
					return;
				case "reasoning_delta":
					setAwaitingModel(false);
					setLines((current) => appendToLast(current, "thinking", event.text));
					return;
				case "tool_start":
					setAwaitingModel(false);
					setLines((current) => [
						...current,
						{
							kind: "tool",
							callId: event.callId,
							name: event.name,
							args: event.args,
							running: true,
							isError: false,
							durationMs: undefined,
							summary: undefined,
							detail: "",
							content: undefined,
							details: undefined,
						},
					]);
					return;
				case "tool_update":
					setLines((current) =>
						updateTool(current, event.callId, (line) => ({ ...line, detail: line.detail + event.text })),
					);
					return;
				case "tool_end":
					setLines((current) =>
						updateTool(current, event.callId, (line) => ({
							...line,
							running: false,
							isError: event.isError,
							durationMs: event.durationMs,
							summary: event.summary,
							content: event.content,
							details: event.details,
						})),
					);
					setActivity((current) => applyToolDuration(current, event.durationMs));
					return;
				case "turn_end":
					setLines(sealStreaming);
					return;
				case "usage_recorded":
					if (event.contextTokens !== undefined) setContextTokens(event.contextTokens);
					setUsage((current) => applyUsageRecorded(current, event));
					setActivity((current) => applyActivityRecorded(current, event));
					return;
				case "retrying":
					setLines((current) => [
						...current,
						{
							kind: "notice",
							text: `重试中 (${event.attempt}/${event.maxAttempts})：${event.reason}`,
							tone: "info",
						},
					]);
					return;
				case "compaction_start":
					setLines((current) => [
						...current,
						{ kind: "notice", text: `压缩上下文：替换前 ${event.messages} 条消息`, tone: "info" },
					]);
					return;
				case "compaction_end":
					setLines((current) => [
						...current,
						{
							kind: "notice",
							text: `压缩完成：~${event.tokensBefore} → ${event.tokensAfter} tokens`,
							tone: "info",
						},
					]);
					setContextTokens(event.tokensAfter);
					return;
				case "compaction_failed":
				case "compaction_skipped":
					setLines((current) => [...current, { kind: "notice", text: event.message, tone: "info" }]);
					return;
				case "notice":
					setLines((current) => [...current, { kind: "notice", text: event.message, tone: "info" }]);
					return;
				case "aborted":
					setLines((current) => [...current, { kind: "notice", text: "已停止", tone: "info" }]);
					return;
				case "error":
					setLines((current) => [...current, { kind: "notice", text: event.message, tone: "error" }]);
					return;
				case "run_end":
					setRunning(false);
					setAwaitingModel(false);
					setLines(sealStreaming);
					refreshSessions();
					refreshGit();
					return;
				case "approval_request":
					setAwaitingModel(false);
					setApproval({ id: event.id, request: event.request });
					return;
				case "approval_cleared":
					setApproval(undefined);
					return;
				case "session_switched":
					setLines([]);
					setContextTokens(undefined);
					setActivePanel(undefined);
					setSideFullscreen(false);
					reload();
					refreshSessions();
					refreshGit();
					refreshSettings();
					return;
				default:
					return;
			}
		},
		[reload, refreshGit, refreshSessions, refreshSettings],
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

	useEffect(() => {
		const onResize = (): void => {
			// 收展只在跨越阈值的那一次事件里有动作,越界触发不需要去抖攒批,攒了反而显得迟钝
			const action = autoSidebarAction(window.innerWidth, sidebarCollapsed, autoCollapsed);
			if (action === true) {
				setSidebarCollapsed(true);
				setAutoCollapsed(true);
			} else if (action === false) {
				setSidebarCollapsed(false);
				setAutoCollapsed(false);
			}
			const available = window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth);
			if (sideOpen && available < 720) {
				setSideOpen(false);
				setSideFullscreen(false);
			}
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [sidebarCollapsed, sidebarWidth, sideOpen, autoCollapsed]);

	/** 使用者亲手收展侧栏（按钮或 Ctrl+B）：自动收起的来作废，之后不再代为展开。 */
	const toggleSidebar = useCallback((): void => {
		setAutoCollapsed(false);
		setSidebarCollapsed((value) => !value);
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

	const newTask = useCallback((): void => {
		setSettingsOpen(false);
		setActivePanel(undefined);
		setSideFullscreen(false);
		void api.newSession().catch((error: unknown) => {
			toast(error instanceof Error ? error.message : String(error), "error");
		});
	}, []);

	const togglePin = useCallback((id: string): void => {
		setPinned((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			writePinnedSessions(next);
			return next;
		});
	}, []);

	const switchSession = useCallback(
		(id: string): void => {
			setActivePanel(undefined);
			setSideFullscreen(false);
			if (id === sessionId) return;
			setSettingsOpen(false);
			void api.switchSession(id).catch((error: unknown) => {
				toast(error instanceof Error ? error.message : String(error), "error");
			});
		},
		[sessionId],
	);

	const send = useCallback((text: string): void => {
		setActivePanel(undefined);
		setSideFullscreen(false);
		setLines((current) => [...current, { kind: "user", text }]);
		void api.send(text).catch((error: unknown) => {
			setLines((current) => [
				...current,
				{ kind: "notice", text: error instanceof Error ? error.message : String(error), tone: "error" },
			]);
		});
		// 首条消息落盘的瞬间会话才在磁盘上存在,这里让侧栏及时补上真实条目
		refreshSessions();
		setActivity((current) => ({ ...current, turns: current.turns + 1 }));
	}, [refreshSessions]);

	const stop = useCallback((): void => {
		void api.abort().catch(() => {});
	}, []);

	const answer = useCallback((id: number, value: ApprovalAnswer): void => {
		setApproval(undefined);
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

	const updateSettings = useCallback((update: { effort?: ThinkingLevel; approval?: ApprovalMode }): void => {
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
	}, []);

	const openTab = useCallback((tab: SideTab): void => {
		setSideTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
		setActiveTabId(tab.id);
		setSideOpen(true);
	}, []);

	const openFilesTab = useCallback((): void => {
		openTab({ id: "files", kind: "files", title: "文件" });
	}, [openTab]);

	const openGitTab = useCallback((): void => {
		openTab({ id: "git", kind: "git", title: "Git" });
	}, [openTab]);

	const openSkillsTab = useCallback((): void => {
		openTab({ id: "skills", kind: "skills", title: "技能" });
	}, [openTab]);

	const openPluginsTab = useCallback((): void => {
		openTab({ id: "plugins", kind: "plugins", title: "插件" });
	}, [openTab]);

	const openFile = useCallback(
		(path: string): void => {
			const name = path.split(/[\\/]/).pop() ?? path;
			openTab({ id: `code:${path}`, kind: "code", title: name, path });
		},
		[openTab],
	);

	const addSideTab = useCallback(
		(kind: SideTabKind): void => {
			if (kind === "files") openFilesTab();
			else if (kind === "git") openGitTab();
			else if (kind === "skills") openSkillsTab();
			else if (kind === "plugins") openPluginsTab();
			else if (kind === "browser") openTab({ id: "browser", kind: "browser", title: "浏览器" });
			else openTab({ id: "terminal", kind: "terminal", title: "终端" });
		},
		[openFilesTab, openGitTab, openPluginsTab, openSkillsTab, openTab],
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

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const command = event.ctrlKey || event.metaKey;
			if (command && event.key.toLowerCase() === "b") {
				event.preventDefault();
				toggleSidebar();
				return;
			}
			if (command && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setCommandOpen((value) => !value);
				return;
			}
			if (command && event.key.toLowerCase() === "n") {
				event.preventDefault();
				newTask();
				return;
			}
			const target = event.target as HTMLElement | null;
			const typing = target !== null && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
			if (event.key === "Escape" && running && !typing) {
				event.preventDefault();
				stop();
				return;
			}
			if (typing || approval === undefined) return;
			const canAlways = approval.request.saveLabel !== undefined;
			const map: Record<string, ApprovalAnswer> = { "1": "once", "3": "deny" };
			map["2"] = canAlways ? "always" : "deny";
			const value = map[event.key];
			if (value !== undefined) {
				event.preventDefault();
				answer(approval.id, value);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [answer, approval, newTask, running, stop]);

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
		contextTokens,
		contextWindow,
		usage,
		activity,
		onSend: send,
		onStop: stop,
		onApprovalMode: changeApprovalMode,
		onPlanMode: changePlanMode,
		onModel: changeModel,
		onEffort: changeEffort,
		onNewTask: newTask,
		onSettings: () => setSettingsOpen(true),
		onCompact: () => {
			void api.compact().catch((error: unknown) => {
				toast(error instanceof Error ? error.message : String(error), "error");
			});
		},
	};

	const draft = lines.length === 0 && !running && activePanel === undefined;
	const currentTitle = sessions.find((session) => session.id === sessionId)?.title ?? "新会话";

	useEffect(() => {
		document.title = currentTitle === "新会话" ? "Reins" : `${currentTitle} · Reins`;
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

	const main = activePanel === "plugins" ? (
		<PluginsPage plugins={plugins} onClose={() => setActivePanel(undefined)} />
	) : activePanel === "schedules" ? (
		<SchedulesPage onClose={() => setActivePanel(undefined)} />
	) : (
		<>
			<ConversationHeader
				blank={draft}
				workspace={workspaceName(cwd) || "Reins"}
				title={currentTitle}
				canGoBack={canGoBack}
				canGoForward={canGoForward}
				rightbarOpen={sideOpen}
				onBack={goBack}
				onForward={goForward}
				onToggleRightbar={toggleSidePane}
			/>

			<div
				className="flex min-h-0 flex-1 flex-col"
				style={{ "--chat-content-width": "clamp(680px, 64%, 920px)" } as unknown as CSSProperties}
			>
				{loadError !== undefined ? (
					<div className="flex flex-1 items-center justify-center px-6 text-[13px] text-destructive">
						无法连接：{loadError}
					</div>
				) : draft ? (
					<Hero
						workspace={workspaceName(cwd)}
						composer={<Composer {...composerProps} hero />}
					/>
				) : (
					<>
						<div className="relative min-h-0 flex-1">
							<ScrollFadeViewport ref={scrollRef} onScroll={onScroll} className="h-full">
								<div className="px-4">
									<div className="mx-auto w-full max-w-[var(--chat-content-width)] pb-6 pt-4">
										<TranscriptView lines={lines} />
										{awaitingModel ? (
											<div className="mt-4">
												<LoadingPixels />
											</div>
										) : null}
									</div>
								</div>
							</ScrollFadeViewport>
							<MessageRail lines={lines} scrollRef={scrollRef} />
							{!atBottom ? (
								<button
									type="button"
									onClick={jumpToBottom}
									title="回到底部"
									aria-label="回到底部"
									className="absolute bottom-4 right-[max(calc((100%_-_var(--chat-content-width))_/_2),16px)] z-20 flex size-[34px] items-center justify-center rounded-full border-0 bg-card text-foreground shadow-panel-elevated transition-colors hover:bg-surface-hover"
								>
									<ArrowDown className="size-4" />
								</button>
							) : null}
						</div>

						<div className="sticky bottom-0 shrink-0 bg-[linear-gradient(180deg,transparent_0px,var(--background)_36px)] px-4 pb-4 pt-6">
							<div className="mx-auto w-full max-w-[var(--chat-content-width)]">
								{approval === undefined ? null : (
									<div className="mb-1.5">
										<ApprovalCard
											request={approval.request}
											onAnswer={(value) => answer(approval.id, value)}
										/>
									</div>
								)}
								<Composer {...composerProps} />
							</div>
						</div>
					</>
				)}
			</div>
		</>
	);

	return (
		<>
			<AppShell
				sidebarWidth={sidebarWidth}
				sidebarCollapsed={sidebarCollapsed}
				rightbarWidth={sideWidth}
				rightbarOpen={sideOpen}
				rightbarFullscreen={sideFullscreen}
				onSidebarWidth={(width) => setSidebarWidth(clampSidebar(width))}
				onRightbarWidth={(width) =>
					setSideWidth(
						Math.max(
							RIGHTBAR_MIN,
							Math.min(Math.round(window.innerWidth * RIGHTBAR_MAX_RATIO), Math.round(width)),
						),
					)
				}
				onToggleSidebar={toggleSidebar}
				onNewSession={newTask}
				sidebar={
					<Sidebar
						sessions={sessions}
						archived={archived}
						pinned={pinned}
						currentId={sessionId}
						currentIsDraft={lines.length === 0}
						running={running}
						cwd={cwd}
						version={settings?.version ?? ""}
						connected={connectionOk}
						activePanel={activePanel}
						onNewSession={newTask}
						onSwitch={switchSession}
						onArchive={(id) => {
							void api.archiveSessions([id]).then(refreshSessions).catch(() => {});
						}}
						onDelete={(id) => {
							void api.deleteSessions([id]).then(refreshSessions).catch(() => {});
						}}
						onRestore={(id) => {
							void api.restoreSessions([id]).then(refreshSessions).catch(() => {});
						}}
						onTogglePin={togglePin}
						onOpenPanel={(panel) => {
							setActivePanel(panel);
							setSettingsOpen(false);
							setSideFullscreen(false);
						}}
						onOpenSettings={() => setSettingsOpen(true)}
					/>
				}
				rightbar={sidePane}
			>
				{main}
			</AppShell>

			<ToastHost />
			{settingsOpen ? (
				<SettingsPage
					settings={settings}
					archived={archived}
					themeMode={theme.mode}
					onThemeMode={theme.setMode}
					onClose={() => setSettingsOpen(false)}
					onUpdate={updateSettings}
					onModel={changeModel}
					onRestore={(id) => {
						void api.restoreSessions([id]).then(refreshSessions).catch(() => {});
					}}
				/>
			) : null}
			<CommandPalette
				open={commandOpen}
				sessions={sessions}
				onClose={() => setCommandOpen(false)}
				onNewTask={() => {
					setCommandOpen(false);
					newTask();
				}}
				onSettings={() => {
					setCommandOpen(false);
					setSettingsOpen(true);
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
