import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { api, openEventStream } from "./api.ts";
import { ApprovalCard } from "./approval-card.tsx";
import { Composer } from "./composer.tsx";
import { appendToLast, linesFromEntries, sealStreaming, updateTool, type Line } from "./transcript.ts";
import { TranscriptView } from "./transcript-view.tsx";
import type { ApprovalAnswer, ApprovalRequest, WebEvent } from "./types.ts";

/**
 * 界面主组件。
 *
 * 状态只有一份行列表与几个开关:历史由 /api/session 一次性重放,此后只靠事件流增量拼接。
 * 所有事件处理都走函数式更新,不依赖快照,断线重连也不需要回放补帧——重连时整页刷新即可。
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
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const handleEvent = useCallback((event: WebEvent): void => {
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
				return;
			case "approval_request":
				setApproval({ id: event.id, request: event.request });
				return;
			case "approval_cleared":
				setApproval(undefined);
				return;
			default:
				return;
		}
	}, []);

	useEffect(() => {
		let disposeStream: (() => void) | undefined;
		void (async () => {
			try {
				const [state, session] = await Promise.all([api.state(), api.session()]);
				setRunning(state.running);
				setApproval(state.approval);
				setSessionId(session.id);
				setLines(linesFromEntries(session.entries));
				disposeStream = openEventStream(handleEvent, setConnected);
			} catch (error) {
				setLoadError(error instanceof Error ? error.message : String(error));
			}
		})();
		return () => disposeStream?.();
	}, [handleEvent]);

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
			const answer = map[event.key];
			if (answer !== undefined) {
				setApproval(undefined);
				void api.approve(approval.id, answer).catch(() => {});
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

	const answer = useCallback(
		(id: number, value: ApprovalAnswer): void => {
			setApproval(undefined);
			void api.approve(id, value).catch(() => {
				// 结论没送到的唯一原因是连接问题;审批桥仍在等,重连后重新回答
			});
		},
		[],
	);

	return (
		<div className="app">
			<header>
				<span className="brand">Reins</span>
				<span className="meta">{sessionId}</span>
				<span className="spacer" />
				{totalTokens > 0 && <span className="tokens">{totalTokens.toLocaleString()} tok</span>}
				<span className={"conn" + (connected ? " on" : "")}>
					{connected ? "connected" : "reconnecting"}
				</span>
			</header>
			{loadError !== undefined ? (
				<div className="load-error">无法连接: {loadError}</div>
			) : (
				<>
					<div className="scroll" ref={scrollRef}>
						{lines.length === 0 && !running ? <div className="greeting">今天要做点什么?</div> : null}
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
					<Composer running={running} onSend={send} onStop={stop} />
				</>
			)}
		</div>
	);
}
