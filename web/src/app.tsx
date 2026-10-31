import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { api, openEventStream } from "./api.ts";
import { ApprovalCard } from "./components/approval-card.tsx";
import { Composer } from "./components/composer.tsx";
import { Header } from "./components/header.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { appendToLast, linesFromEntries, sealStreaming, updateTool, type Line } from "./transcript/lines.ts";
import { TranscriptView } from "./transcript/view.tsx";
import type { ApprovalAnswer, ApprovalMode, ApprovalRequest, ModelInfo, WebEvent } from "./protocol.ts";

/** 时段问候;草稿态的主视觉文案。 */
function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "夜深了,注意休息";
	if (hour < 11) return "早上好,今天从什么开始?";
	if (hour < 13) return "中午好,上午进展如何?";
	if (hour < 18) return "下午好,继续推进";
	return "晚上好,今天辛苦了";
}

const QUICK_PROMPTS: readonly { label: string; prompt: string }[] = [
	{ label: "总结这个项目", prompt: "总结这个项目的结构与用途" },
	{ label: "修复失败的测试", prompt: "运行项目测试,修复失败的用例" },
	{ label: "审查未提交改动", prompt: "审查工作区未提交的改动,按严重程度列出问题" },
];

function workspaceName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? cwd;
}

/**
 * 界面主组件。
 *
 * 布局复刻 zcode 桌面版:左侧任务栏 + 右侧内容列;空闲时内容列是「问候 + 居中输入卡 +
 * 快捷任务」,会话进行时是时间线 + 落底输入。历史由 /api/session 一次性重放,此后只靠
 * 事件流增量拼接;切会话/新建会话由服务端广播 session_switched,前端整份重载。
 */
export function App(): ReactElement {
	const [lines, setLines] = useState<readonly Line[]>([]);
	const [running, setRunning] = useState(false);
	/** turn 已开始但模型还没吐出任何可见内容:像素加载行只在这一窗口出现 */
	const [awaitingModel, setAwaitingModel] = useState(false);
	const [approval, setApproval] = useState<{ id: number; request: ApprovalRequest } | undefined>(
		undefined,
	);
	const [totalTokens, setTotalTokens] = useState(0);
	const [connected, setConnected] = useState(false);
	const [sessionId, setSessionId] = useState("");
	const [cwd, setCwd] = useState("");
	const [sessions, setSessions] = useState<readonly { id: string; title: string | undefined; updatedAt: string }[]>([]);
	const [models, setModels] = useState<readonly ModelInfo[]>([]);
	const [model, setModel] = useState<ModelInfo>({ provider: "", model: "", name: "" });
	const [approvalMode, setApprovalModeState] = useState<ApprovalMode>("ask");
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const refreshSessions = useCallback((): void => {
		void api
			.sessions()
			.then(setSessions)
			.catch(() => {});
	}, []);

	/** 首屏与切会话共用的整份重载:状态、会话条目、清单一次拿齐。 */
	const reload = useCallback((): void => {
		void (async () => {
			try {
				const [state, session] = await Promise.all([api.state(), api.session()]);
				setRunning(state.running);
				setAwaitingModel(state.running);
				setApproval(state.approval);
				setApprovalModeState(state.approvalMode);
				setModel(state.model);
				setSessionId(session.id);
				setCwd(session.cwd);
				setLines(linesFromEntries(session.entries));
			} catch (error) {
				setLoadError(error instanceof Error ? error.message : String(error));
			}
		})();
	}, []);

	const handleEvent = useCallback(
		(event: WebEvent): void => {
			switch (event.type) {
				case "turn_start":
					// 新回合的增量不得接上上一回合的尾巴
					setLines(sealStreaming);
					setRunning(true);
					setAwaitingModel(true);
					return;
				case "writing_tool_call":
					// 参数还在流式传输:对界面只是「有内容了」,不落行
					setAwaitingModel(false);
					return;
				case "text_delta":
					setAwaitingModel(false);
					setLines((prev) => appendToLast(prev, "assistant", event.text));
					return;
				case "reasoning_delta":
					setAwaitingModel(false);
					setLines((prev) => appendToLast(prev, "thinking", event.text));
					return;
				case "tool_start":
					setAwaitingModel(false);
					setLines((prev) => [
						...prev,
						{
							kind: "tool",
							callId: event.callId,
							name: event.name,
							running: true,
							isError: false,
							durationMs: undefined,
							summary: undefined,
							detail: "",
						},
					]);
					return;
				case "tool_update":
					setLines((prev) =>
						updateTool(prev, event.callId, (line) => ({ ...line, detail: line.detail + event.text })),
					);
					return;
				case "tool_end":
					setLines((prev) =>
						updateTool(prev, event.callId, (line) => ({
							...line,
							running: false,
							isError: event.isError,
							durationMs: event.durationMs,
							summary: event.summary,
						})),
					);
					return;
				case "usage_recorded":
					setTotalTokens((prev) => prev + event.tokens);
					return;
				case "retrying":
					setLines((prev) => [
						...prev,
						{ kind: "notice", text: `retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}`, tone: "info" },
					]);
					return;
				case "compaction_start":
					setLines((prev) => [
						...prev,
						{ kind: "notice", text: `compacting: replacing the first ${event.messages} messages`, tone: "info" },
					]);
					return;
				case "compaction_end":
					setLines((prev) => [
						...prev,
						{ kind: "notice", text: `compacted: ~${event.tokensBefore} → ${event.tokensAfter} tokens`, tone: "info" },
					]);
					return;
				case "compaction_failed":
				case "compaction_skipped":
					setLines((prev) => [...prev, { kind: "notice", text: event.message, tone: "info" }]);
					return;
				case "notice":
					setLines((prev) => [...prev, { kind: "notice", text: event.message, tone: "info" }]);
					return;
				case "aborted":
					setLines((prev) => [...prev, { kind: "notice", text: "stopped", tone: "info" }]);
					return;
				case "error":
					setLines((prev) => [...prev, { kind: "notice", text: event.message, tone: "error" }]);
					return;
				case "run_end":
					setRunning(false);
					setAwaitingModel(false);
					// 标题来自第一句用户消息,此刻才进得了清单
					refreshSessions();
					return;
				case "approval_request":
					setApproval({ id: event.id, request: event.request });
					return;
				case "approval_cleared":
					setApproval(undefined);
					return;
				case "session_switched":
					setLines([]);
					setTotalTokens(0);
					reload();
					refreshSessions();
					return;
				default:
					return;
			}
		},
		[reload, refreshSessions],
	);

	useEffect(() => {
		let disposeStream: (() => void) | undefined;
		void (async () => {
			reload();
			refreshSessions();
			try {
				setModels(await api.models());
			} catch {
				// 模型清单拿不到时选择器空着,不挡会话
			}
			disposeStream = openEventStream(handleEvent, setConnected);
		})();
		return () => disposeStream?.();
	}, [handleEvent, reload, refreshSessions]);

	// 内容一变就贴底;审批卡片弹出时同样贴,保证它进入视野
	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null) el.scrollTop = el.scrollHeight;
	}, [lines, approval, awaitingModel]);

	// 全局键位:Esc 中断回合,1/2/3 直接回答审批(输入焦点在文本框里时不劫持)
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const target = event.target as HTMLElement | null;
			const typing = target !== null && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
			if (event.key === "Escape" && running) {
				void api.abort().catch(() => {});
				return;
			}
			if (typing || approval === undefined) return;
			const canAlways = approval.request.saveLabel !== undefined;
			const map: Record<string, ApprovalAnswer> = { "1": "once", "3": "deny" };
			if (canAlways) map["2"] = "always";
			else map["2"] = "deny";
			const value = map[event.key];
			if (value !== undefined) {
				setApproval(undefined);
				void api.approve(approval.id, value).catch(() => {});
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [running, approval]);

	const send = useCallback((text: string): void => {
		// 自己的消息先画上去:内核没有「用户已发言」事件,等重放就晚了一整个回合
		setLines((prev) => [...prev, { kind: "user", text }]);
		void api.send(text).catch((error: unknown) => {
			setLines((prev) => [
				...prev,
				{ kind: "notice", text: error instanceof Error ? error.message : String(error), tone: "error" },
			]);
		});
	}, []);

	const stop = useCallback((): void => {
		void api.abort().catch(() => {});
	}, []);

	const answer = useCallback((id: number, value: ApprovalAnswer): void => {
		setApproval(undefined);
		void api.approve(id, value).catch(() => {
			// 结论没送到的唯一原因是连接问题;审批桥仍在等,重连后重新回答
		});
	}, []);

	const switchSession = useCallback((id: string): void => {
		void api.switchSession(id).catch(() => {});
	}, []);

	const newTask = useCallback((): void => {
		void api.newSession().catch(() => {});
	}, []);

	const changeModel = useCallback((next: ModelInfo): void => {
		setModel(next);
		void api.setModel(next.provider, next.model).catch(() => {});
	}, []);

	const changeApprovalMode = useCallback((mode: ApprovalMode): void => {
		setApprovalModeState(mode);
		void api.setApprovalMode(mode).catch(() => {});
	}, []);

	const draft = lines.length === 0 && !running;
	const composerProps = {
		running,
		workspace: workspaceName(cwd),
		approvalMode,
		onApprovalMode: changeApprovalMode,
		models,
		model,
		onModel: changeModel,
		onSend: send,
		onStop: stop,
	};

	return (
		<div className="workspace">
			<Sidebar sessions={sessions} currentId={sessionId} onSwitch={switchSession} onNew={newTask} />
			<div className="content">
				<Header sessionId={sessionId} totalTokens={totalTokens} connected={connected} />
				{loadError !== undefined ? (
					<div className="load-error">无法连接: {loadError}</div>
				) : draft ? (
					<div className="draft">
						<div className="watermark" aria-hidden>
							R
						</div>
						<div className="draft-body">
							<div className="greeting">{greeting()}</div>
							<Composer {...composerProps} />
							<div className="chips">
								{QUICK_PROMPTS.map((item) => (
									<button type="button" key={item.label} className="quick" onClick={() => send(item.prompt)}>
										{item.label}
									</button>
								))}
							</div>
						</div>
					</div>
				) : (
					<>
						<div className="scroll" ref={scrollRef}>
							<TranscriptView lines={lines} />
							{awaitingModel ? (
								<div className="waiting">
									<span className="pixels">
										<i />
										<i />
										<i />
										<i />
										<i />
										<i />
										<i />
										<i />
										<i />
									</span>
									思考中
								</div>
							) : null}
						</div>
						{approval !== undefined && (
							<ApprovalCard request={approval.request} onAnswer={(value) => answer(approval.id, value)} />
						)}
						<Composer {...composerProps} />
					</>
				)}
			</div>
		</div>
	);
}
