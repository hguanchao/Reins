import {
	ArrowUp,
	AtSign,
	Blocks,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Eye,
	FolderOpen,
	GripVertical,
	Map as MapIcon,
	Plus,
	ShieldCheck,
	Sparkles,
	Square,
	X,
	Zap,
	ZapOff,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type KeyboardEvent,
	type ReactElement,
} from "react";

import { api } from "../api.ts";
import { cn } from "../components/ui/cn.ts";
import { Popover } from "../components/ui/popover.tsx";
import { formatCost, formatTokens } from "../lib/format.ts";
import { desktopBridge } from "../platform.ts";
import type {
	ActivitySummary,
	ApprovalMode,
	McpServerInfo,
	ModelInfo,
	SettingsModel,
	SkillInfo,
	ThinkingLevel,
	UsageSummary,
} from "../protocol.ts";

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
	ask: "逐次询问",
	auto: "自动审查",
	yolo: "直接放行",
};

const APPROVAL_HINTS: Record<ApprovalMode, string> = {
	ask: "每次写盘或执行命令都停下确认",
	auto: "先由审查模型判断，风险高才问你",
	yolo: "不再询问，路径边界仍然生效",
};

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

/** 输入卡最多 5 行，第 6 行起内部滚动。 */
const LINE_HEIGHT = 22;
const MIN_LINES = 2;
const MAX_LINES = 5;

/** 排队的一条消息：只在本机会话内存在，清空后整条收起。 */
export interface QueuedMessage {
	readonly id: string;
	readonly text: string;
}

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

interface MentionItem {
	readonly token: string;
	readonly description: string;
}

interface MentionState {
	readonly kind: "file" | "skill" | "command";
	readonly query: string;
	readonly start: number;
	readonly files: readonly string[];
	readonly index: number;
}

/** 会话内命令：只有真实接上的动作才列进来。 */
const COMMANDS: readonly { readonly token: string; readonly description: string }[] = [
	{ token: "/compact", description: "压缩上下文，把长会话换成摘要继续" },
	{ token: "/clear", description: "新建任务，开一段干净的会话" },
	{ token: "/settings", description: "打开设置" },
];

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
						<span className="chip br-chip" title={`当前分支 ${props.branch}`}>
							<GitBranchIcon />
							<span className="n">{props.branch}</span>
						</span>
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

function PencilIcon(): ReactElement {
	return (
		<svg className="ic-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		</svg>
	);
}

function GitBranchIcon(): ReactElement {
	return (
		<svg className="ic-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M15 6a9 9 0 0 0-9 9V3" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
		</svg>
	);
}

/** 缓存命中率只统计输入侧；输出不经过缓存，不参与计算。 */
function hitRate(usage: UsageSummary): number | undefined {
	const inputSide = usage.input + usage.cacheRead + usage.cacheWrite;
	return inputSide > 0 ? Math.round((usage.cacheRead / inputSide) * 100) : undefined;
}

function mentionItems(state: MentionState | undefined, skills: readonly SkillInfo[]): readonly MentionItem[] {
	if (state === undefined) return [];
	const needle = state.query.toLowerCase();
	if (state.kind === "file") {
		return state.files.map((path) => ({ token: path, description: "" }));
	}
	if (state.kind === "skill") {
		return skills
			.filter((skill) => skill.name.toLowerCase().includes(needle))
			.slice(0, 8)
			.map((skill) => ({ token: skill.name, description: skill.description }));
	}
	const commands = COMMANDS.filter((command) => command.token.includes(needle)).map((command) => ({
		token: command.token,
		description: command.description,
	}));
	const matched = skills
		.filter((skill) => skill.name.toLowerCase().includes(needle))
		.slice(0, 6)
		.map((skill) => ({ token: skill.name, description: skill.description }));
	return [...commands, ...matched];
}

/** 分组只在 `/` 时出现：命令在上、技能在下。 */
function groupMentions(
	state: MentionState | undefined,
	items: readonly MentionItem[],
): readonly { readonly label: string; readonly items: readonly MentionItem[] }[] {
	if (state === undefined) return [];
	if (state.kind === "command") {
		const commands = items.filter((item) => item.token.startsWith("/"));
		const skills = items.filter((item) => !item.token.startsWith("/"));
		return [
			{ label: "命令", items: commands },
			{ label: "技能", items: skills },
		].filter((group) => group.items.length > 0);
	}
	return [{ label: state.kind === "file" ? "文件" : "技能", items }];
}

/** 加号浮层：根级四项，鼠标移入行时二级菜单在右侧级联浮出。 */
function AddMenu({
	skills,
	mcpServers,
	workspacePath,
	onInsert,
	onSettings,
}: {
	readonly skills: readonly SkillInfo[];
	readonly mcpServers: readonly McpServerInfo[];
	readonly workspacePath: string;
	onInsert(token: string): void;
	onSettings(): void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const bridge = desktopBridge();
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const close = (): void => setOpen(false);

	return (
		<div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
			<button
				type="button"
				className="add"
				title="添加文件或调用指令"
				aria-label="添加文件或调用指令"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<Plus className="ic-14" />
			</button>
			{open ? (
				<div
					className="pop add-menu animate-pop"
					role="menu"
					style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 45 }}
				>
					<div className="add-row">
						<button type="button" className="pop-i">
							<AtSign className="ic-14" />
							<span>添加文件</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onInsert("@");
										close();
									}}
								>
									引用文件
								</button>
								{bridge === undefined ? null : (
									<button
										type="button"
										className="pop-i"
										onClick={() => {
											bridge.openWorkspaceFolder(workspacePath);
											close();
										}}
									>
										在资源管理器中打开
									</button>
								)}
							</div>
						</div>
					</div>

					<div className="add-row">
						<button type="button" className="pop-i">
							<FolderOpen className="ic-14" />
							<span>引用工作区文件</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onInsert("@");
										close();
									}}
								>
									搜索文件…
								</button>
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onInsert(`${workspacePath} `);
										close();
									}}
								>
									引用整个工作区
								</button>
							</div>
						</div>
					</div>

					<div className="add-row">
						<button type="button" className="pop-i">
							<Sparkles className="ic-14" />
							<span>技能</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								{skills.length === 0 ? (
									<div className="pop-i two" style={{ pointerEvents: "none" }}>
										<span className="sk-col">
											<span className="n">还没有技能</span>
											<span className="d">从设置里上传或放入技能目录</span>
										</span>
									</div>
								) : (
									skills.slice(0, 6).map((skill) => (
										<button
											key={skill.path}
											type="button"
											className="pop-i two"
											onClick={() => {
												onInsert(`$${skill.name} `);
												close();
											}}
										>
											<span className="sk-col">
												<span className="n">{skill.name}</span>
												<span className="d">{skill.description}</span>
											</span>
										</button>
									))
								)}
								<div className="pop-sep" />
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onSettings();
										close();
									}}
								>
									管理技能
								</button>
							</div>
						</div>
					</div>

					<div className="add-row">
						<button type="button" className="pop-i">
							<Blocks className="ic-14" />
							<span>连接器</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								{mcpServers.length === 0 ? (
									<div className="pop-i two" style={{ pointerEvents: "none" }}>
										<span className="sk-col">
											<span className="n">还没有连接器</span>
											<span className="d">MCP 服务器接入后在下一回合可用</span>
										</span>
									</div>
								) : (
									mcpServers.slice(0, 6).map((server) => (
										<div key={server.name} className="pop-i two" style={{ pointerEvents: "none" }}>
											<span className="sk-col">
												<span className="n">{server.name}</span>
												<span className="d">{serverStatusLabel(server.status)}</span>
											</span>
										</div>
									))
								)}
								<div className="pop-sep" />
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onSettings();
										close();
									}}
								>
									管理连接器
								</button>
							</div>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

function serverStatusLabel(status: string): string {
	switch (status) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "unreachable":
			return "连接失败";
		case "disabled":
			return "已禁用";
		default:
			return "未连接";
	}
}

/** 模式选择器：芯片显示当前档名；浮层里计划模式置顶，审批方式其次。 */
function ModeChip({
	planMode,
	approvalMode,
	onPlanMode,
	onApprovalMode,
}: {
	readonly planMode: boolean;
	readonly approvalMode: ApprovalMode;
	onPlanMode(enabled: boolean): void;
	onApprovalMode(mode: ApprovalMode): void;
}): ReactElement {
	const Icon = planMode ? MapIcon : approvalMode === "yolo" ? Zap : approvalMode === "auto" ? Eye : ShieldCheck;
	return (
		<Popover
			align="start"
			trigger={({ toggle, open }) => (
				<button
					type="button"
					className="chip"
					onClick={toggle}
					aria-haspopup="menu"
					aria-expanded={open}
					title="计划模式与审批方式"
				>
					<Icon className="ic-12" />
					<span>{planMode ? "计划模式" : APPROVAL_LABELS[approvalMode]}</span>
					<ChevronDown className="ic-12" />
				</button>
			)}
		>
			<div className="mode-panel">
				<button type="button" className="pop-i plan-row" onClick={() => onPlanMode(!planMode)}>
					<MapIcon className="ic-14" />
					<span className="min-w-0 flex-1">计划模式</span>
					<span className="sw" aria-checked={planMode} role="switch" aria-label="计划模式">
						<i />
					</span>
				</button>
				<div className={cn("ap-sec", planMode && "off")}>
					<div className="sec-label">审批方式</div>
					{(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
						<button
							key={mode}
							type="button"
							className={cn("pop-i two", mode === approvalMode && "sel")}
							onClick={() => onApprovalMode(mode)}
						>
							<span className="sk-col">
								<span className="n">{APPROVAL_LABELS[mode]}</span>
								<span className="d">{APPROVAL_HINTS[mode]}</span>
							</span>
							<Check className="ic-12 ck" />
						</button>
					))}
				</div>
			</div>
		</Popover>
	);
}

/** 模型 · 思考合并选择器：一级提供商、二级模型与思考强度。 */
function ModelChip({
	model,
	models,
	effort,
	levels,
	onModel,
	onEffort,
	onSettings,
}: {
	readonly model: ModelInfo;
	readonly models: readonly SettingsModel[];
	readonly effort: ThinkingLevel;
	readonly levels: readonly ThinkingLevel[];
	onModel(provider: string, model: string): void;
	onEffort(effort: ThinkingLevel): void;
	onSettings(): void;
}): ReactElement {
	const [providerId, setProviderId] = useState<string | undefined>(undefined);

	const providers = useMemo(() => {
		const map = new Map<string, { readonly id: string; readonly name: string; readonly models: SettingsModel[] }>();
		for (const item of models) {
			const entry = map.get(item.provider) ?? { id: item.provider, name: item.providerName, models: [] };
			entry.models.push(item);
			map.set(item.provider, entry);
		}
		return [...map.values()];
	}, [models]);

	const inProvider = providers.find((entry) => entry.models.some((item) => item.model === model.model));
	const effortIndex = Math.max(0, levels.indexOf(effort));
	const entry = providers.find((item) => item.id === providerId);

	return (
		<Popover
			trigger={({ toggle, open }) => (
				<button
					type="button"
					className="chip"
					onClick={() => {
						setProviderId(undefined);
						toggle();
					}}
					aria-haspopup="listbox"
					aria-expanded={open}
					title="模型与思考深度"
				>
					<span>{model.name}</span>
					{effort === "off" ? null : (
						<>
							<span className="sep" />
							<span>思考 {EFFORT_LABELS[effort]}</span>
						</>
					)}
					<ChevronDown className="ic-12" />
				</button>
			)}
		>
			{() =>
				entry === undefined ? (
					<div className="model-panel py-1">
						{providers.length === 0 ? (
							<div className="pop-i" style={{ pointerEvents: "none" }}>
								没有可用模型
							</div>
						) : (
							providers.map((item) => (
								<button
									key={item.id}
									type="button"
									className={cn("pop-i pv-item", inProvider?.id === item.id && "sel")}
									onClick={() => {
										// 进入提供商时若当前模型不在其下，自动落到它的第一个模型
										if (!item.models.some((candidate) => candidate.model === model.model)) {
											const first = item.models[0];
											if (first !== undefined) onModel(item.id, first.model);
										}
										setProviderId(item.id);
									}}
								>
									<span className="pv-logo">{item.name.slice(0, 1).toUpperCase()}</span>
									<span className="min-w-0 flex-1 truncate">{item.name}</span>
									<Check className="ic-12 pv-check" />
								</button>
							))
						)}
						<div className="pop-sep" />
						<button type="button" className="pop-i pv-manage" onClick={onSettings}>
							管理模型
						</button>
					</div>
				) : (
					<div className="model-panel py-1">
						<div className="mv-head">
							<button
								type="button"
								className="mv-back"
								aria-label="返回提供商列表"
								onClick={() => setProviderId(undefined)}
							>
								<ChevronLeft className="ic-12" />
							</button>
							<span className="mv-name">{entry.name}</span>
						</div>
						<div className="mv-label">模型</div>
						{entry.models.map((item) => (
							<button
								key={item.model}
								type="button"
								className={cn("pop-i", item.model === model.model && "sel")}
								onClick={() => onModel(entry.id, item.model)}
							>
								<span className="min-w-0 flex-1 truncate">{item.name}</span>
								{item.model === model.model ? <Check className="ic-12 ck" /> : null}
							</button>
						))}
						{levels.length <= 1 ? null : (
							<>
								<div className="es-head">
									<span className="l">思考强度</span>
									<span className="k">Ctrl 1 循环</span>
									<span className="v">{EFFORT_LABELS[effort]}</span>
								</div>
								<div
									className="es-track"
									role="slider"
									tabIndex={0}
									aria-label="思考强度"
									aria-valuemin={0}
									aria-valuemax={levels.length - 1}
									aria-valuenow={effortIndex}
									aria-valuetext={EFFORT_LABELS[effort]}
									onClick={(event) => {
										const rect = event.currentTarget.getBoundingClientRect();
										const ratio = (event.clientX - rect.left) / rect.width;
										const next =
											levels[
												Math.min(levels.length - 1, Math.max(0, Math.round(ratio * (levels.length - 1))))
											];
										if (next !== undefined) onEffort(next);
									}}
									onKeyDown={(event) => {
										if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
										event.preventDefault();
										const step = event.key === "ArrowRight" ? 1 : -1;
										const next = levels[Math.min(levels.length - 1, Math.max(0, effortIndex + step))];
										if (next !== undefined) onEffort(next);
									}}
								>
									{levels.map((level, index) => (
										<span
											key={`pt-${level}`}
											className="pt"
											style={{ left: `${(index / Math.max(1, levels.length - 1)) * 100}%` }}
										/>
									))}
									<span
										className="es-thumb"
										style={{ left: `${(effortIndex / Math.max(1, levels.length - 1)) * 100}%` }}
									/>
								</div>
							</>
						)}
					</div>
				)
			}
		</Popover>
	);
}

/** 工作区浮层：搜索 + 最近工作空间 + 打开本地文件夹。 */
function WorkspacePicker({
	name,
	onPick,
}: {
	readonly name: string;
	onPick(path: string | null): void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<readonly { readonly path: string; readonly name: string }[]>([]);
	const bridge = desktopBridge();

	useEffect(() => {
		void api
			.workspaces()
			.then(setItems)
			.catch(() => {});
	}, []);

	const filtered = items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));

	return (
		<>
			<div className="wsp-search">
				<svg className="ic-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
					<path d="m21 21-4.34-4.34" />
					<circle cx="11" cy="11" r="8" />
				</svg>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索工作区"
					aria-label="搜索工作区"
				/>
			</div>
			<div className="wsp-list">
				{filtered.length === 0 ? (
					<div className="pop-i" style={{ pointerEvents: "none", color: "var(--ink-3)" }}>
						没有匹配的工作区
					</div>
				) : (
					filtered.map((item) => (
						<button
							key={item.path}
							type="button"
							className={cn("pop-i", item.name === name && "on")}
							onClick={() => onPick(item.path)}
						>
							<FolderOpen className="ic-14" />
							<span className="n">{item.name}</span>
						</button>
					))
				)}
			</div>
			<div className="pop-sep" />
			{bridge === undefined ? null : (
				<button
					type="button"
					className="pop-i"
					onClick={() => {
						void bridge.chooseWorkspace().then((chosen) => {
							if (chosen) onPick(null);
						});
					}}
				>
					<Plus className="ic-14" />
					打开本地文件夹…
				</button>
			)}
			<button type="button" className="pop-i" onClick={() => onPick(null)}>
				<ZapOff className="ic-14" />
				不绑定工作区
			</button>
		</>
	);
}

/** 上下文圆环：点击展开 token 构成；没有数据时不出现。 */
function ContextMeter({
	tokens,
	window: contextWindow,
}: {
	readonly tokens: number | undefined;
	readonly window: number | undefined;
}): ReactElement | null {
	if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return null;
	const ratio = Math.min(1, tokens / contextWindow);
	const percent = Math.round(ratio * 100);
	const circumference = 2 * Math.PI * 4.5;

	return (
		<Popover
			align="start"
			trigger={({ toggle }) => (
				<button type="button" className="ctx" onClick={toggle} aria-label="上下文占用" title="上下文占用，点击查看构成">
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
						<circle className="ring-bg" cx="6" cy="6" r="4.5" fill="none" strokeWidth="2" />
						<circle
							className="ring-fg"
							cx="6"
							cy="6"
							r="4.5"
							fill="none"
							strokeWidth="2"
							strokeLinecap="round"
							strokeDasharray={circumference}
							strokeDashoffset={circumference * (1 - ratio)}
							transform="rotate(-90 6 6)"
						/>
					</svg>
					<span>
						<b style={{ fontWeight: 500, color: "var(--ink)" }}>{percent}%</b> 上下文
					</span>
				</button>
			)}
		>
			{(close) => (
				<div className="ctx-panel">
					<div className="cx-head">
						<span>上下文用量</span>
						<button type="button" className="cx-close" onClick={close} aria-label="关闭">
							<X className="ic-12" />
						</button>
					</div>
					<div className="cx-big">
						<b>{percent}%</b>
						<span>
							~{formatTokens(tokens)} / {formatTokens(contextWindow)}
						</span>
					</div>
					<div className="cx-bar">
						<i style={{ width: `${percent}%`, background: "var(--ink)" }} />
					</div>
					<div className="cx-rows">
						<div className="cx-row">
							<span className="d" style={{ background: "var(--ink)" }} />
							<span>已用</span>
							<span className="n">{formatTokens(tokens)}</span>
						</div>
						<div className="cx-row">
							<span className="d" style={{ background: "var(--ink-4)" }} />
							<span>剩余</span>
							<span className="n">{formatTokens(Math.max(0, contextWindow - tokens))}</span>
						</div>
					</div>
					<div className="cx-foot">窗口 {formatTokens(contextWindow)} · 压缩阈值由内核按窗口自动判定</div>
				</div>
			)}
		</Popover>
	);
}

/** 会话头读数：速率与费用。 */
export function sessionReadout(usage: UsageSummary, activity: ActivitySummary): readonly string[] {
	const speed =
		activity.decodeMs > 0
			? `${Math.round(activity.decodeTokens / (activity.decodeMs / 1000))} tok/s`
			: undefined;
	const cost = formatCost(usage.cost);
	return [speed, cost].filter((value): value is string => value !== undefined);
}
