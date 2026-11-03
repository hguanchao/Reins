import { ArrowDown, GitBranch, Info, PanelRight, PanelRightClose } from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent,
	type ReactElement,
} from "react";

import { api, openEventStream } from "./api.ts";
import { ApprovalCard } from "./chat/approval-card.tsx";
import { Composer, type ComposerProps } from "./chat/composer.tsx";
import { LoadingPixels } from "./chat/loading-pixels.tsx";
import { TranscriptView } from "./chat/transcript.tsx";
import { Button, Dialog, ScrollFadeViewport, ToastHost, toast } from "./components/ui/index.ts";
import { IconButton } from "./components/ui/button.tsx";
import { cn } from "./components/ui/cn.ts";
import { CodePane } from "./panels/code-pane.tsx";
import { FilesPane } from "./panels/files-pane.tsx";
import { GitPane } from "./panels/git-pane.tsx";
import { PluginsPane } from "./panels/plugins-pane.tsx";
import { SidePane } from "./panels/side-pane.tsx";
import { SkillsPane } from "./panels/skills-pane.tsx";
import type { SideTab } from "./panels/types.ts";
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
	WebEvent,
} from "./protocol.ts";
import { SettingsPage } from "./settings/settings-page.tsx";
import { AppShell } from "./shell/app-shell.tsx";
import { CommandPalette } from "./shell/command-palette.tsx";
import { Sidebar } from "./shell/sidebar.tsx";
import { TopOverlay } from "./shell/top-overlay.tsx";
import { WorkspaceHeader } from "./shell/workspace-header.tsx";
import { WindowControls } from "./shell/window-controls.tsx";
import { workspaceName } from "./lib/format.ts";
import { readPinnedSessions, writePinnedSessions } from "./state/pinned.ts";
import { useTheme } from "./state/theme.ts";
import { appendToLast, linesFromEntries, sealStreaming, updateTool, type Line } from "./transcript/lines.ts";

const STICK_THRESHOLD = 80;
const SIDEBAR_MIN = 240;
const SIDEBAR_DEFAULT = 276;
const SIDE_PANE_MIN = 240;
const SIDE_PANE_DEFAULT = 480;

const QUICK_PROMPTS: readonly { readonly label: string; readonly prompt: string }[] = [
	{ label: "总结这个项目", prompt: "总结这个项目的结构与用途" },
	{ label: "修复失败的测试", prompt: "运行项目测试，修复失败的用例" },
	{ label: "审查未提交改动", prompt: "审查工作区未提交的改动，按严重程度列出问题" },
];

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "夜深了，注意休息";
	if (hour < 11) return "早上好，今天从什么开始？";
	if (hour < 13) return "中午好，上午进展如何？";
	if (hour < 18) return "下午好，继续推进";
	return "晚上好，今天辛苦了";
}

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
	const [git, setGit] = useState<GitStatus | null>(null);
	const [skills, setSkills] = useState<readonly SkillInfo[]>([]);
	const [plugins, setPlugins] = useState<readonly PluginInfo[]>([]);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const [sideTabs, setSideTabs] = useState<readonly SideTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
	const [sideOpen, setSideOpen] = useState(false);
	const [sideWidth, setSideWidth] = useState(SIDE_PANE_DEFAULT);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [commandOpen, setCommandOpen] = useState(false);
	const [scheduledOpen, setScheduledOpen] = useState(false);
	const [pluginsPlaceholderOpen, setPluginsPlaceholderOpen] = useState(false);
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

	/** 会话切换后记一笔浏览历史；后退/前进自己触发的切换不重复入栈。 */
	const rememberSession = useCallback(
		(id: string): void => {
			if (id.length === 0) return;
			if (navigatingRef.current) {
				navigatingRef.current = false;
				updateHistoryButtons();
				return;
			}
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
		setSettingsOpen(false);
		updateHistoryButtons();
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
		setSettingsOpen(false);
		updateHistoryButtons();
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
				rememberSession(state.sessionId);
				setCwd(state.cwd);
				setContextWindow(state.contextWindow);
				setContextTokens(state.contextTokens);
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
					return;
				case "turn_end":
					setLines(sealStreaming);
					return;
				case "usage_recorded":
					if (event.contextTokens !== undefined) setContextTokens(event.contextTokens);
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
		let timer = 0;
		const onResize = (): void => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				const contentWidth = window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth);
				if (sideOpen && contentWidth < 480) setSideOpen(false);
				if (!sidebarCollapsed && contentWidth < 360) setSidebarCollapsed(true);
			}, 300);
		};
		window.addEventListener("resize", onResize);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("resize", onResize);
		};
	}, [sidebarCollapsed, sidebarWidth, sideOpen]);

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
			if (id === sessionId) return;
			setSettingsOpen(false);
			void api.switchSession(id).catch((error: unknown) => {
				toast(error instanceof Error ? error.message : String(error), "error");
			});
		},
		[sessionId],
	);

	const send = useCallback((text: string): void => {
		setLines((current) => [...current, { kind: "user", text }]);
		void api.send(text).catch((error: unknown) => {
			setLines((current) => [
				...current,
				{ kind: "notice", text: error instanceof Error ? error.message : String(error), tone: "error" },
			]);
		});
	}, []);

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

	const closeTab = useCallback(
		(id: string): void => {
			setSideTabs((current) => {
				const next = current.filter((item) => item.id !== id);
				setActiveTabId((active) => (active === id ? next[next.length - 1]?.id : active));
				return next;
			});
		},
		[],
	);

	const toggleSidePane = useCallback((): void => {
		if (sideOpen) {
			setSideOpen(false);
			return;
		}
		if (sideTabs.length === 0) openFilesTab();
		else setSideOpen(true);
	}, [openFilesTab, sideOpen, sideTabs.length]);

	const startSidebarResize = useCallback(
		(event: PointerEvent<HTMLDivElement>): void => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = sidebarWidth;
			const onMove = (move: globalThis.PointerEvent): void => {
				const max = window.innerWidth * 0.5;
				setSidebarWidth(Math.round(Math.max(SIDEBAR_MIN, Math.min(max, startWidth + move.clientX - startX))));
			};
			const onUp = (): void => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[sidebarWidth],
	);

	const startSidePaneResize = useCallback(
		(event: PointerEvent<HTMLDivElement>): void => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = sideWidth;
			const onMove = (move: globalThis.PointerEvent): void => {
				const max = window.innerWidth * 0.65;
				setSideWidth(Math.round(Math.max(SIDE_PANE_MIN, Math.min(max, startWidth - (move.clientX - startX)))));
			};
			const onUp = (): void => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[sideWidth],
	);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const command = event.ctrlKey || event.metaKey;
			if (command && event.key.toLowerCase() === "b") {
				event.preventDefault();
				setSidebarCollapsed((value) => !value);
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
	const disconnected = everConnected.current && !connected;

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

	if (settingsOpen) {
		return (
			<div className="flex h-full flex-col bg-background-win-alt">
				<div className="drag-region h-1 shrink-0" />
				<div className="min-h-0 flex-1 overflow-hidden px-1 pb-1">
					<div className="flex h-full flex-col overflow-hidden rounded-(--workspace-panel-radius) border-[0.5px] border-border bg-background shadow-xs">
						<SettingsPage
							settings={settings}
							themeMode={theme.mode}
							onThemeMode={theme.setMode}
							onClose={() => setSettingsOpen(false)}
							onUpdate={updateSettings}
							onModel={changeModel}
						/>
					</div>
				</div>
				<ToastHost />
			</div>
		);
	}

	const draft = lines.length === 0 && !running;
	const currentTitle = sessions.find((session) => session.id === sessionId)?.title ?? "新任务";

	return (
		<div className="relative flex h-full min-h-0 w-full overflow-hidden bg-background-win-alt">
			<TopOverlay
				sidebarCollapsed={sidebarCollapsed}
				canGoBack={canGoBack}
				canGoForward={canGoForward}
				onBack={goBack}
				onForward={goForward}
				onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
				onNewTask={newTask}
			/>
			<AppShell
				sidebar={
					sidebarCollapsed ? (
						<div className="drag-region h-full w-1 shrink-0" />
					) : (
						<>
							<div className="drag-region h-1 shrink-0" />
							<Sidebar
								sessions={sessions}
								archived={archived}
								pinned={pinned}
								currentId={sessionId}
								running={running}
								cwd={cwd}
								width={sidebarWidth}
								version={settings?.version ?? ""}
								onNewTask={newTask}
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
								onOpenPluginsPlaceholder={() => setPluginsPlaceholderOpen(true)}
								onOpenScheduled={() => setScheduledOpen(true)}
								onOpenSettings={() => setSettingsOpen(true)}
							/>
						</>
					)
				}
				resizeHandle={
					sidebarCollapsed ? undefined : (
						<div
							role="separator"
							aria-orientation="vertical"
							aria-label="调整侧栏宽度"
							onPointerDown={startSidebarResize}
							className="group/handle relative z-10 flex h-full w-1 shrink-0 cursor-ew-resize touch-none items-center justify-center"
						>
							<span className="absolute inset-y-2 w-0.5 rounded-full bg-transparent transition-colors group-hover/handle:bg-foreground-subtlest/50 group-active/handle:bg-foreground-subtlest/50" />
						</div>
					)
				}
				sidePane={
					sideOpen ? (
						<>
							<div
								role="separator"
								aria-orientation="vertical"
								aria-label="调整面板宽度"
								onPointerDown={startSidePaneResize}
								className="group/handle relative z-10 flex h-full w-1 shrink-0 cursor-ew-resize touch-none items-center justify-center"
							>
								<span className="absolute inset-y-2 w-0.5 rounded-full bg-transparent transition-colors group-hover/handle:bg-foreground-subtlest/50 group-active/handle:bg-foreground-subtlest/50" />
							</div>
							<div className="min-h-0 flex h-full min-w-0 flex-col pr-1 pb-1" style={{ width: sideWidth }}>
								<SidePane
									tabs={sideTabs}
									activeId={activeTabId}
									onSelect={setActiveTabId}
									onClose={closeTab}
									onClosePane={() => setSideOpen(false)}
									onAdd={(kind) => {
										if (kind === "files") openFilesTab();
										else if (kind === "git") openGitTab();
										else if (kind === "skills") openSkillsTab();
										else openPluginsTab();
									}}
								>
									{activeTab?.kind === "files" ? (
										<FilesPane git={git} onOpenFile={openFile} />
									) : null}
									{activeTab?.kind === "code" ? <CodePane path={activeTab.path} /> : null}
									{activeTab?.kind === "git" ? (
										<GitPane status={git} onRefresh={refreshGit} onOpenFile={openFile} />
									) : null}
									{activeTab?.kind === "skills" ? <SkillsPane skills={skills} /> : null}
									{activeTab?.kind === "plugins" ? <PluginsPane plugins={plugins} /> : null}
								</SidePane>
							</div>
						</>
					) : undefined
				}
			>
				<section
					className={cn(
						"relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
						"rounded-(--workspace-panel-radius) border-[0.5px] border-border shadow-xs",
						sideOpen && "rounded-r-none border-r-0",
					)}
				>
					<WorkspaceHeader
						variant={draft ? "draft" : "task"}
						leading={
							<>
								{draft ? (
									<span className="min-w-0 truncate text-ui-base font-medium text-foreground-subtle">
										{workspaceName(cwd) || "Reins"}
									</span>
								) : (
									<span className="min-w-0 truncate text-ui-base font-medium text-foreground">
										{currentTitle}
									</span>
								)}
								{git !== null && git.branch !== "" ? (
									<span className="hidden shrink-0 items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle md:inline-flex">
										<GitBranch className="size-3" />
										{git.branch}
									</span>
								) : null}
							</>
						}
						actions={
							<>
								{disconnected ? (
									<span className="flex items-center gap-1.5 rounded-md bg-warning-surface px-2 py-1 text-ui-xs text-warning-surface-foreground">
										<Info className="size-3.5" />
										重连中
									</span>
								) : null}
								<IconButton
									label={sideOpen ? "关闭面板" : "打开面板"}
									size="icon-sm"
									onClick={toggleSidePane}
								>
									{sideOpen ? (
										<PanelRightClose className="size-4" />
									) : (
										<PanelRight className="size-4" />
									)}
								</IconButton>
								<WindowControls />
							</>
						}
					/>

					{loadError !== undefined ? (
						<div className="flex flex-1 items-center justify-center px-6 text-ui-sm text-destructive">
							无法连接:{loadError}
						</div>
					) : draft ? (
						<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
							<div className="flex min-h-full w-full flex-col items-center justify-center px-6 pb-10">
								<div className="flex w-full max-w-2xl flex-col items-center gap-6">
									<img
										src="/logo.svg"
										alt=""
										className="size-16 shrink-0 [mask-image:linear-gradient(to_bottom,black_30%,transparent_100%)]"
									/>
									<span className="text-ui-xl font-medium tracking-tight text-foreground">
										{greeting()}
									</span>
									<Composer {...composerProps} />
									<div className="flex flex-wrap justify-center gap-2">
										{QUICK_PROMPTS.map((item) => (
											<Button
												key={item.label}
												variant="outline"
												size="sm"
												className="rounded-lg text-ui-caption text-foreground-subtle hover:text-foreground"
												onClick={() => send(item.prompt)}
											>
												{item.label}
											</Button>
										))}
									</div>
								</div>
							</div>
						</div>
					) : (
						<>
							<div className="relative min-h-0 flex-1">
								<ScrollFadeViewport
									ref={scrollRef}
									onScroll={onScroll}
									className="h-full [scrollbar-gutter:stable_both-edges]"
								>
									<div className="mx-auto w-full max-w-4xl px-4 pb-6 pt-4">
										<TranscriptView lines={lines} />
										{awaitingModel ? (
											<div className="mt-4">
												<LoadingPixels />
											</div>
										) : null}
									</div>
								</ScrollFadeViewport>
								{!atBottom ? (
									<button
										type="button"
										onClick={jumpToBottom}
										title="回到底部"
										aria-label="回到底部"
										className={cn(
											"absolute bottom-3 right-4 z-20 flex size-7 items-center justify-center rounded-full border border-border bg-card text-foreground-subtle shadow-md transition-colors hover:bg-card-selected hover:text-foreground",
										)}
									>
										<ArrowDown className="size-4" />
									</button>
								) : null}
							</div>

							<div className="sticky bottom-0 shrink-0 px-4 pb-4">
								<div className="mx-auto w-full max-w-4xl">
									{approval === undefined ? null : (
										<div className="mb-3">
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
				</section>
			</AppShell>

			<ToastHost />
			<CommandPalette
				open={commandOpen}
				sessions={sessions}
				onClose={() => setCommandOpen(false)}
				onNewTask={newTask}
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

			<Dialog open={scheduledOpen} onClose={() => setScheduledOpen(false)} title="定时任务">
				<p className="text-ui-base leading-6 text-foreground-subtle">
					当前版本还没有调度器。定时任务需要宿主侧的持久化调度与后台会话，这里不会创建假的定时任务。
				</p>
			</Dialog>

			<Dialog
				open={pluginsPlaceholderOpen}
				onClose={() => setPluginsPlaceholderOpen(false)}
				title="插件"
			>
				<p className="text-ui-base leading-6 text-foreground-subtle">
					插件功能还没有确定，先保留入口占位；后续会在这里接入插件的安装、启用与配置。
				</p>
			</Dialog>
		</div>
	);
}
