import { ArrowUp, Check, ChevronDown, FolderOpen, GripVertical, Square, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";
import { api } from "../api.ts";
import { cn } from "../components/ui/cn.ts";
import { Popover } from "../components/ui/popover.tsx";
import { formatTokens } from "../lib/format.ts";
import type { ActivitySummary, ApprovalMode, McpServerInfo, ModelInfo, SettingsModel, SkillInfo, ThinkingLevel, UsageSummary } from "../protocol.ts";
import { LINE_HEIGHT, MIN_LINES, MAX_LINES, hitRate, mentionItems, groupMentions } from "./composer/model.ts";
import type { MentionState, QueuedMessage } from "./composer/model.ts";
import { PencilIcon, GitBranchIcon } from "./composer/icons.tsx";
import { AddMenu } from "./composer/add-menu.tsx";
import { ModeChip } from "./composer/mode-chip.tsx";
import { ModelChip } from "./composer/model-chip.tsx";
import { WorkspacePicker } from "./composer/workspace-picker.tsx";
import { ContextMeter } from "./composer/context-meter.tsx";

export { sessionReadout } from "./composer/model.ts";
export type { QueuedMessage };

export interface ComposerProps {
	readonly running: boolean;
	readonly approvalMode: ApprovalMode;
	readonly planMode: boolean;
	readonly effort: ThinkingLevel;
	readonly model: ModelInfo;
	readonly models: readonly SettingsModel[];
	readonly skills: readonly SkillInfo[];
	readonly mcpServers: readonly McpServerInfo[];
	readonly workspaceName: string;
	readonly workspacePath: string;
	readonly branch: string | undefined;
	readonly contextTokens: number | undefined;
	readonly contextWindow: number | undefined;
	readonly usage: UsageSummary;
	readonly activity: ActivitySummary;
	/** 空态：显示卡帽（工作区与分支）并允许解绑 */
	readonly blank?: boolean;
	readonly queue: readonly QueuedMessage[];
	/** 划选文本插入的引用；消费后清空 */
	readonly quote?: string;
	onSend(text: string): void;
	onStop(): void;
	onApprovalMode(mode: ApprovalMode): void;
	onPlanMode(enabled: boolean): void;
	onModel(provider: string, model: string): void;
	onEffort(effort: ThinkingLevel): void;
	onNewTask(workspacePath?: string | null): void;
	onOpenSettings(): void;
	onCompact(): void;
	onQueueRemove(id: string): void;
	onQueueEdit(id: string, text: string): void;
	onQueueSendNow(id: string): void;
	onQueueReorder(from: number, to: number): void;
	onQuoteConsumed(): void;
}

/**
 * 输入卡。
 *
 * 整屏唯一带投影的实体面。工具栏只放三类控件：加号（引用入口）、模式、模型·思考，再加
 * 一枚发送钮——回合进行中它就是停止，不另设排队钮，排队一律走 Enter。
 */
export function Composer(props: ComposerProps): ReactElement {
	const [text, setText] = useState("");
	const [mention, setMention] = useState<MentionState | undefined>(undefined);
	const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | undefined>(undefined);
	const [dragIndex, setDragIndex] = useState<number | undefined>(undefined);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const historyRef = useRef<string[]>([]);
	const historyIndexRef = useRef(-1);

	useEffect(() => {
		const element = textareaRef.current;
		if (element === null) return;
		const max = LINE_HEIGHT * MAX_LINES + 16;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, max)}px`;
	}, [text]);

	// 划选文本「引用」：以 > 块写入输入框并聚焦
	const quote = props.quote;
	const onQuoteConsumed = props.onQuoteConsumed;
	useEffect(() => {
		if (quote === undefined) return;
		const quoted = quote
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
		setText((current) => (current.length === 0 ? `${quoted}\n\n` : `${current.replace(/\s*$/, " ")}${quoted}\n\n`));
		onQuoteConsumed();
		requestAnimationFrame(() => textareaRef.current?.focus());
	}, [quote, onQuoteConsumed]);

	// @ 文件搜索：输入变化后稍等再发，避免每敲一个字符都打一次接口
	useEffect(() => {
		if (mention?.kind !== "file") return;
		const query = mention.query;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void api
				.fileSearch(query, 8)
				.then((hits) => {
					if (cancelled) return;
					setMention((current) =>
						current === undefined || current.kind !== "file" || current.query !== query
							? current
							: { ...current, files: hits.map((hit) => hit.path), index: 0 },
					);
				})
				.catch(() => {});
		}, 150);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [mention?.kind, mention?.query]);

	const currentModel = useMemo(
		() => props.models.find((item) => item.provider === props.model.provider && item.model === props.model.model),
		[props.models, props.model.provider, props.model.model],
	);
	const effortLevels = currentModel?.thinkingLevels ?? (["off"] as const);

	const updateMention = useCallback((value: string, caret: number): void => {
		const before = value.slice(0, caret);
		// 只在词首触发：否则路径里的 / 会被当成指令
		const match = /(^|\s)([@$/])([^\s@$/]*)$/.exec(before);
		if (match === null) {
			setMention(undefined);
			return;
		}
		const symbol = match[2] ?? "";
		const query = match[3] ?? "";
		const start = caret - query.length - 1;
		const kind = symbol === "@" ? "file" : symbol === "$" ? "skill" : "command";
		setMention((current) => ({
			kind,
			query,
			start,
			files: current?.kind === "file" && current.query === query ? current.files : [],
			index: 0,
		}));
	}, []);

	const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
		const value = event.target.value;
		setText(value);
		updateMention(value, event.target.selectionStart ?? value.length);
	};

	/** 采纳一条候选：替换触发词并补一个空格。 */
	const acceptMention = useCallback(
		(token: string): void => {
			const active = mention;
			const element = textareaRef.current;
			if (active === undefined || element === null) return;
			const caret = element.selectionStart ?? text.length;
			const prefix = text.slice(0, active.start);
			const suffix = text.slice(caret);
			const symbol = active.kind === "file" ? "@" : active.kind === "skill" ? "$" : "/";
			const insert = `${symbol}${token} `;
			setText(`${prefix}${insert}${suffix}`);
			setMention(undefined);
			requestAnimationFrame(() => {
				element.focus();
				const position = prefix.length + insert.length;
				element.setSelectionRange(position, position);
			});
		},
		[mention, text],
	);

	const insertToken = (token: string): void => {
		const element = textareaRef.current;
		const caret = element?.selectionStart ?? text.length;
		const next = `${text.slice(0, caret)}${token}${text.slice(caret)}`;
		setText(next);
		requestAnimationFrame(() => {
			element?.focus();
			element?.setSelectionRange(caret + token.length, caret + token.length);
		});
	};

	const submit = useCallback((): void => {
		const value = text.trim();
		if (value.length === 0) return;
		if (value === "/clear") {
			setText("");
			props.onNewTask(null);
			return;
		}
		if (value === "/settings") {
			setText("");
			props.onOpenSettings();
			return;
		}
		if (value === "/compact") {
			setText("");
			props.onCompact();
			return;
		}
		historyRef.current = [...historyRef.current, value].slice(-50);
		historyIndexRef.current = -1;
		setText("");
		setMention(undefined);
		props.onSend(value);
	}, [props, text]);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		const items = mentionItems(mention, props.skills);
		if (mention !== undefined && items.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setMention({ ...mention, index: (mention.index + 1) % items.length });
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setMention({ ...mention, index: (mention.index - 1 + items.length) % items.length });
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const item = items[mention.index];
				if (item !== undefined) {
					event.preventDefault();
					acceptMention(item.token);
					return;
				}
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setMention(undefined);
				return;
			}
		}

		if (event.key === "Escape" && props.running) {
			event.preventDefault();
			props.onStop();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
			return;
		}

		const element = event.currentTarget;
		const atStart = element.selectionStart === 0 && element.selectionEnd === 0;
		if (event.key === "ArrowUp" && atStart && historyRef.current.length > 0) {
			event.preventDefault();
			const next =
				historyIndexRef.current === -1
					? historyRef.current.length - 1
					: Math.max(0, historyIndexRef.current - 1);
			historyIndexRef.current = next;
			setText(historyRef.current[next] ?? "");
			return;
		}
		if (event.key === "ArrowDown" && atStart && historyIndexRef.current !== -1) {
			event.preventDefault();
			const next = historyIndexRef.current + 1;
			if (next >= historyRef.current.length) {
				historyIndexRef.current = -1;
				setText("");
			} else {
				historyIndexRef.current = next;
				setText(historyRef.current[next] ?? "");
			}
		}
	};

	const placeholder = props.running
		? "当前回合进行中，Enter 加入队列 · @ 引用文件 · $ 调用技能"
		: props.blank === true
			? "想做什么？按 Enter 开始…"
			: "继续这个任务，Enter 发送 · @ 引用文件 · $ 调用技能…";

	const hasStatus =
		props.activity.steps > 0 ||
		props.usage.requests > 0 ||
		(props.contextTokens !== undefined && props.contextWindow !== undefined && props.contextWindow > 0);

	const mentionList = mentionItems(mention, props.skills);

	return (
		<div className="comp-unit">
			{props.blank === true ? (
				<div className="comp-cap">
					<span className={cn("chip ws-chip", props.workspacePath.length === 0 && "is-unbound")}>
						<Popover
							align="start"
							placement="above"
							trigger={({ toggle, open }) => (
								<button
									type="button"
									className="chip-tap"
									onClick={toggle}
									aria-haspopup="menu"
									aria-expanded={open}
									title="切换工作区"
								>
									<FolderOpen className="ic-14" />
									<span className="n">
										{props.workspaceName.length === 0 ? "选择工作区" : props.workspaceName}
									</span>
								</button>
							)}
						>
							{(close) => (
								<div className="ws-picker">
									<WorkspacePicker
										name={props.workspaceName}
										onPick={(path) => {
											close();
											props.onNewTask(path);
										}}
									/>
								</div>
							)}
						</Popover>
						{props.workspacePath.length === 0 ? null : (
							<button
								type="button"
								className="chip-x"
								title="取消绑定工作区"
								aria-label="取消绑定工作区"
								onClick={() => props.onNewTask(null)}
							>
								<X className="ic-12" />
							</button>
						)}
						<ChevronDown className="ic-12 ck" />
					</span>
					{props.branch === undefined ? null : (
						<Popover
							align="start"
							placement="above"
							className="br-picker"
							trigger={({ toggle, open }) => (
								<button
									type="button"
									className="chip br-chip"
									title="切换分支"
									aria-haspopup="menu"
									aria-expanded={open}
									onClick={toggle}
								>
									<GitBranchIcon />
									<span className="n">{props.branch}</span>
									<ChevronDown className="ic-12" />
								</button>
							)}
						>
							<div className="pop-h">分支</div>
							<div className="pop-i sel">
								<GitBranchIcon />
								<span className="n">{props.branch}</span>
								<Check className="ic-12 ck" />
							</div>
						</Popover>
					)}
				</div>
			) : null}

			{mentionList.length > 0 ? (
				<div className="mention" role="listbox" aria-label="补全候选">
					<div className="mention-list">
						{groupMentions(mention, mentionList).map((group) => (
							<div key={group.label} className="mention-group">
								<div className="mention-g">{group.label}</div>
								{group.items.map((item) => {
									const position = mentionList.indexOf(item);
									return (
										<button
											key={`${group.label}-${item.token}`}
											type="button"
											role="option"
											aria-selected={position === mention?.index}
											className="mention-i"
											onMouseDown={(event) => {
												event.preventDefault();
												acceptMention(item.token);
											}}
										>
											<span className="t">{item.token}</span>
											<span className="d">{item.description}</span>
										</button>
									);
								})}
							</div>
						))}
					</div>
					<div className="mention-foot">
						<span className="h">输入内容以搜索命令、技能或文件</span>
						<span className="k">↑↓ 选择 · Enter 采纳</span>
					</div>
				</div>
			) : null}

			<div className={cn("composer", props.blank === true && "hatted")}>
				{props.queue.length === 0 ? null : (
					<div className="q-strip">
						<div className="q-head">
							<span className="n">排队 {props.queue.length} 条</span>
							<span>· 拖动排序 · 回合结束后依次发出</span>
						</div>
						{props.queue.map((item, index) => (
							<div
								key={item.id}
								className={cn("q-i", dragIndex === index && "is-drag")}
								draggable
								onDragStart={() => setDragIndex(index)}
								onDragEnd={() => setDragIndex(undefined)}
								onDragOver={(event) => {
									event.preventDefault();
									if (dragIndex === undefined || dragIndex === index) return;
									props.onQueueReorder(dragIndex, index);
									setDragIndex(index);
								}}
							>
								<GripVertical className="ic-12 grip" />
								<span className="idx">{index + 1}</span>
								{editing?.id === item.id ? (
									<input
										className="tx-edit"
										value={editing.text}
										autoFocus
										aria-label="编辑排队消息"
										onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												const next = editing.text.trim();
												if (next.length > 0) props.onQueueEdit(item.id, next);
												setEditing(undefined);
											}
											if (event.key === "Escape") {
												event.preventDefault();
												setEditing(undefined);
											}
										}}
										onBlur={() => setEditing(undefined)}
									/>
								) : (
									<span className="tx">{item.text}</span>
								)}
								<button
									type="button"
									className="e"
									title="编辑"
									aria-label="编辑这条"
									onClick={() => setEditing({ id: item.id, text: item.text })}
								>
									<PencilIcon />
								</button>
								<button
									type="button"
									className="go"
									title="立即发送（打断当前回合）"
									aria-label="立即发送"
									onClick={() => props.onQueueSendNow(item.id)}
								>
									<Zap className="ic-12" style={{ fill: "currentColor" }} />
								</button>
								<button
									type="button"
									className="x"
									title="撤回这条"
									aria-label="撤回这条"
									onClick={() => props.onQueueRemove(item.id)}
								>
									<X className="ic-12" />
								</button>
							</div>
						))}
					</div>
				)}

				<textarea
					ref={textareaRef}
					value={text}
					onChange={onChange}
					onKeyDown={onKeyDown}
					rows={MIN_LINES}
					placeholder={placeholder}
					aria-label="输入消息"
					style={{ minHeight: props.blank === true ? 88 : LINE_HEIGHT * MIN_LINES + 16 }}
				/>

				<div className="cbar">
					<AddMenu
						skills={props.skills}
						mcpServers={props.mcpServers}
						workspacePath={props.workspacePath}
						onInsert={insertToken}
						onSettings={props.onOpenSettings}
					/>
					<ModeChip
						planMode={props.planMode}
						approvalMode={props.approvalMode}
						onPlanMode={props.onPlanMode}
						onApprovalMode={props.onApprovalMode}
					/>
					<span className="grow" />
					<ModelChip
						model={props.model}
						models={props.models}
						effort={props.effort}
						levels={effortLevels}
						onModel={props.onModel}
						onEffort={props.onEffort}
						onSettings={props.onOpenSettings}
					/>
					{props.running ? (
						<button type="button" className="send" title="停止 (Esc)" aria-label="停止生成" onClick={props.onStop}>
							<Square className="ic-12" style={{ fill: "currentColor" }} />
						</button>
					) : (
						<button
							type="button"
							className="send"
							title="发送 (Enter)"
							aria-label="发送消息"
							disabled={text.trim().length === 0}
							onClick={submit}
						>
							<ArrowUp className="ic-14" />
						</button>
					)}
				</div>
			</div>

			{hasStatus ? (
				<div className="status">
					<ContextMeter tokens={props.contextTokens} window={props.contextWindow} />
					<div className="s">
						<span>
							<b>{props.activity.turns}</b> 轮 · <b>{props.activity.steps}</b> 步
						</span>
					</div>
					<div className="s">
						<span>
							<b>{formatTokens(props.usage.total)}</b>
							{hitRate(props.usage) === undefined ? null : <> · 命中 {hitRate(props.usage)}%</>}
						</span>
					</div>
				</div>
			) : null}
		</div>
	);
}
