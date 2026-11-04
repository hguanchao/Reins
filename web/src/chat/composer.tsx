import {
	ArrowUp,
	AtSign,
	ChevronDown,
	Database,
	Gauge,
	Map as MapIcon,
	Plus,
	Settings2,
	ShieldCheck,
	Sparkles,
	Square,
	SquarePen,
	Wrench,
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
import { Menu, Popover, Tooltip, cn, toast, type MenuEntry } from "../components/ui/index.ts";
import { formatCost } from "../lib/format.ts";
import type {
	ActivitySummary,
	ApprovalMode,
	ModelInfo,
	SettingsModel,
	SkillInfo,
	ThinkingLevel,
	UsageSummary,
} from "../protocol.ts";
import { formatDuration } from "../lib/format.ts";

const MAX_INPUT_HEIGHT = 336;

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
	ask: "逐次询问",
	auto: "自动审查",
	yolo: "直接放行",
};

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

interface MentionSuggestion {
	readonly kind: "file" | "skill";
	readonly query: string;
	readonly start: number;
	readonly items: readonly string[];
	readonly index: number;
}

export interface ComposerProps {
	readonly running: boolean;
	readonly approvalMode: ApprovalMode;
	readonly planMode: boolean;
	readonly effort: ThinkingLevel;
	readonly model: ModelInfo;
	readonly models: readonly SettingsModel[];
	readonly skills: readonly SkillInfo[];
	readonly contextTokens: number | undefined;
	readonly contextWindow: number | undefined;
	readonly usage: UsageSummary;
	readonly activity: ActivitySummary;
	readonly hero?: boolean;
	onSend(text: string): void;
	onStop(): void;
	onApprovalMode(mode: ApprovalMode): void;
	onPlanMode(enabled: boolean): void;
	onModel(provider: string, model: string): void;
	onEffort(effort: ThinkingLevel): void;
	onNewTask(): void;
	onSettings(): void;
	onCompact(): void;
}

/** 输入卡：正文、工具栏、发送圆钮；欢迎页与停靠态共用同一张卡。 */
export function Composer(props: ComposerProps): ReactElement {
	const [text, setText] = useState("");
	const [suggestion, setSuggestion] = useState<MentionSuggestion | undefined>(undefined);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const historyRef = useRef<string[]>([]);
	const historyIndexRef = useRef(-1);

	useEffect(() => {
		const element = textareaRef.current;
		if (element === null) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`;
	}, [text]);

	// @ 文件搜索：输入变化后稍等再发，避免每敲一个字符都打一次接口
	useEffect(() => {
		if (suggestion?.kind !== "file") return;
		const query = suggestion.query;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void api
				.fileSearch(query, 8)
				.then((hits) => {
					if (cancelled) return;
					setSuggestion((current) =>
						current === undefined || current.kind !== "file" || current.query !== query
							? current
							: { ...current, items: hits.map((hit) => hit.path), index: 0 },
					);
				})
				.catch(() => {});
		}, 150);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [suggestion?.kind, suggestion?.query]);

	const currentModel = useMemo(
		() => props.models.find((item) => item.provider === props.model.provider && item.model === props.model.model),
		[props.models, props.model.provider, props.model.model],
	);
	const effortLevels = currentModel?.thinkingLevels ?? (["off"] as const);

	const updateSuggestion = useCallback(
		(value: string, caret: number): void => {
			const before = value.slice(0, caret);
			const match = /(^|\s)([@$])([^\s@$]*)$/.exec(before);
			if (match === null) {
				setSuggestion(undefined);
				return;
			}
			const kind = match[2] === "@" ? "file" : "skill";
			const query = match[3] ?? "";
			const start = caret - query.length - 1;
			if (kind === "skill") {
				const items = props.skills
					.map((skill) => skill.name)
					.filter((name) => name.toLowerCase().includes(query.toLowerCase()))
					.slice(0, 8);
				setSuggestion({ kind, query, start, items, index: 0 });
				return;
			}
			setSuggestion((current) => ({
				kind,
				query,
				start,
				items: current?.kind === "file" && current.query === query ? current.items : [],
				index: 0,
			}));
		},
		[props.skills],
	);

	const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
		const value = event.target.value;
		setText(value);
		updateSuggestion(value, event.target.selectionStart ?? value.length);
	};

	const insertMention = useCallback(
		(item: string): void => {
			const active = suggestion;
			const element = textareaRef.current;
			if (active === undefined || element === null) return;
			const caret = element.selectionStart ?? text.length;
			const prefix = text.slice(0, active.start);
			const suffix = text.slice(caret);
			const token = `${active.kind === "file" ? "@" : "$"}${item} `;
			const next = `${prefix}${token}${suffix}`;
			setText(next);
			setSuggestion(undefined);
			requestAnimationFrame(() => {
				element.focus();
				const position = prefix.length + token.length;
				element.setSelectionRange(position, position);
			});
		},
		[suggestion, text],
	);

	const submit = useCallback((): void => {
		const value = text.trim();
		if (value.length === 0 || props.running) return;
		historyRef.current = [...historyRef.current, value].slice(-50);
		historyIndexRef.current = -1;
		setText("");
		setSuggestion(undefined);
		props.onSend(value);
	}, [props, text]);

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

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (suggestion !== undefined && suggestion.items.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSuggestion({ ...suggestion, index: (suggestion.index + 1) % suggestion.items.length });
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSuggestion({
					...suggestion,
					index: (suggestion.index - 1 + suggestion.items.length) % suggestion.items.length,
				});
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const item = suggestion.items[suggestion.index];
				if (item !== undefined) {
					event.preventDefault();
					insertMention(item);
					return;
				}
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setSuggestion(undefined);
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

	const modelEntries = useMemo(() => {
		const grouped = new Map<string, SettingsModel[]>();
		for (const model of props.models) {
			const list = grouped.get(model.providerName) ?? [];
			list.push(model);
			grouped.set(model.providerName, list);
		}
		const entries: MenuEntry[] = [];
		for (const [providerName, models] of grouped) {
			entries.push({ type: "label", label: providerName });
			for (const model of models) {
				entries.push({
					type: "item",
					key: `${model.provider}/${model.model}`,
					label: model.name,
					hint: model.contextWindow === undefined ? undefined : formatTokens(model.contextWindow),
					checked: model.provider === props.model.provider && model.model === props.model.model,
					onSelect: () => props.onModel(model.provider, model.model),
				});
			}
		}
		return entries.length === 0 ? [{ type: "label" as const, label: "没有可用模型" }] : entries;
	}, [props]);

	const placeholder = props.running
		? "正在回复…"
		: "描述你想要构建的内容, / 调用指令, @ 文件或对话";

	// 输入卡下方那排统计:三项都还没数据(草稿会话)时整行不出现,免得留一条空白
	const hasDock =
		props.activity.steps > 0 ||
		props.usage.requests > 0 ||
		(props.contextTokens !== undefined &&
			props.contextWindow !== undefined &&
			props.contextWindow > 0);

	return (
		<div className="relative w-full">
			{suggestion !== undefined && suggestion.items.length > 0 ? (
				<div className="menu-material absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-lg p-1 animate-pop">
					{suggestion.items.map((item, index) => (
						<button
							key={item}
							type="button"
							onMouseDown={(event) => {
								event.preventDefault();
								insertMention(item);
							}}
							className={cn(
								"flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] leading-5",
								index === suggestion.index
									? "bg-surface-hover text-foreground"
									: "text-foreground-subtle",
							)}
						>
							{suggestion.kind === "file" ? (
								<Wrench className="size-3.5 shrink-0" />
							) : (
								<Sparkles className="size-3.5 shrink-0" />
							)}
							<span className="min-w-0 truncate font-mono text-[12px]">{item}</span>
						</button>
					))}
				</div>
			) : null}

			<div
				className={cn(
					"flex w-full flex-col gap-3 rounded-[28px] bg-input pt-2 shadow-[var(--elevation-soft)]",
					"transition-shadow",
				)}
			>
				<textarea
					ref={textareaRef}
					value={text}
					onChange={onChange}
					onKeyDown={onKeyDown}
					rows={1}
					placeholder={placeholder}
					aria-label="输入消息"
					className={cn(
						"w-full resize-none bg-transparent px-3.5 pt-1 pb-0 leading-6 text-foreground outline-none placeholder:text-foreground-subtlest",
						props.hero ? "min-h-[52px]" : "min-h-[36px]",
					)}
					style={{ lineHeight: "24px", fontSize: "var(--content-font-size)" }}
				/>

				<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-2 pt-0.5 pb-1.5">
					<div className="flex min-w-0 items-center gap-3">
						<Menu
							align="start"
							trigger={({ toggle }) => (
								<button
									type="button"
									aria-label="添加文件或调用指令"
									title="添加文件或调用指令"
									onClick={toggle}
									className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-strong text-foreground transition-colors hover:bg-surface-hover"
								>
									<Plus className="size-4" />
								</button>
							)}
							entries={[
								{ type: "item", key: "new", label: "新会话", icon: SquarePen, onSelect: props.onNewTask },
								{ type: "item", key: "settings", label: "设置", icon: Settings2, onSelect: props.onSettings },
								{ type: "separator" },
								{
									type: "item",
									key: "file",
									label: "引用文件",
									icon: AtSign,
									onSelect: () => insertToken("@"),
								},
								{
									type: "item",
									key: "skill",
									label: "调用技能",
									icon: Sparkles,
									onSelect: () => insertToken("$"),
								},
								{ type: "separator" },
								{
									type: "item",
									key: "compact",
									label: "压缩上下文",
									icon: Wrench,
									disabled: props.running,
									onSelect: () => {
										void api.compact().catch((error: unknown) => {
											toast(error instanceof Error ? error.message : String(error), "error");
										});
									},
								},
							]}
						/>

						<button
							type="button"
							onClick={() => props.onPlanMode(!props.planMode)}
							className={cn(
								"flex h-7 items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium transition-colors",
								props.planMode
									? "bg-[var(--business-blue-soft)] text-(--business-blue)"
									: "text-foreground-subtle hover:bg-surface-hover",
							)}
							aria-pressed={props.planMode}
						>
							<MapIcon className="size-3.5" />
							<span>Plan</span>
						</button>

						<Menu
							align="start"
							trigger={({ toggle }) => (
								<button
									type="button"
									onClick={toggle}
								className="flex h-7 min-w-0 max-w-[150px] items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
								aria-label="审批方式"
								>
									<ShieldCheck className="size-3.5 shrink-0" />
									<span className="min-w-0 truncate">{APPROVAL_LABELS[props.approvalMode]}</span>
									<ChevronDown className="size-3 shrink-0 text-foreground-subtlest" />
								</button>
							)}
							entries={(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map<MenuEntry>((mode) => ({
								type: "item",
								key: mode,
								label: APPROVAL_LABELS[mode],
								checked: mode === props.approvalMode,
								onSelect: () => props.onApprovalMode(mode),
							}))}
						/>
					</div>

					<div className="ml-auto flex min-w-0 items-center gap-3">
						{effortLevels.length <= 1 ? null : (
							<Menu
								trigger={({ toggle }) => (
									<button
										type="button"
										onClick={toggle}
										className="flex h-7 items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
										aria-label="思考等级"
									>
										<Sparkles className="size-3.5 shrink-0" />
										<span>{EFFORT_LABELS[props.effort]}</span>
										<ChevronDown className="size-3 shrink-0 text-foreground-subtlest" />
									</button>
								)}
								entries={effortLevels.map<MenuEntry>((level) => ({
									type: "item",
									key: level,
									label: `思考：${EFFORT_LABELS[level]}`,
									checked: level === props.effort,
									onSelect: () => props.onEffort(level),
								}))}
							/>
						)}

						<Menu
							trigger={({ toggle }) => (
								<button
									type="button"
									onClick={toggle}
										className="flex h-7 min-w-0 max-w-[220px] items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
										aria-label="选择模型"
								>
									<span className="min-w-0 truncate">{props.model.name}</span>
									<ChevronDown className="size-3 shrink-0 text-foreground-subtlest" />
								</button>
							)}
							entries={modelEntries}
							className="max-h-80 w-72"
						/>

						{props.running ? (
							<button
								type="button"
								aria-label="停止生成"
								title="停止 (Esc)"
								onClick={props.onStop}
								className="grid size-[34px] shrink-0 -translate-y-0.5 place-items-center rounded-full bg-[var(--business-blue)] text-white transition-colors hover:opacity-90"
							>
								<Square className="size-3.5 fill-current" />
							</button>
						) : (
							<button
								type="button"
								aria-label="发送消息"
								title="发送 (Enter)"
								disabled={text.trim().length === 0}
								onClick={submit}
								className="grid size-[34px] shrink-0 -translate-y-0.5 place-items-center rounded-full bg-[var(--business-blue)] text-white transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-40"
							>
								<ArrowUp className="size-4" />
							</button>
						)}
						</div>
					</div>
				</div>

				{hasDock ? (
					<div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
						<ActivityPill activity={props.activity} />
						<UsagePill usage={props.usage} />
						<ContextMeter tokens={props.contextTokens} window={props.contextWindow} />
					</div>
				) : null}
			</div>
		);
	}

/** 输入卡下方一排统计里的小字胶囊;三项共用同一形态,内部不折行,窄了整枚换行。 */
const DOCK_PILL = "flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[12px] leading-[18px] font-medium text-foreground-subtle transition-colors hover:bg-surface-hover";

/** 活动胶囊:轮数、步数与生成速度,点开看各段耗时。没有可展示的耗时时退成纯读数。 */
function ActivityPill({ activity }: { readonly activity: ActivitySummary }): ReactElement | null {
	if (activity.steps === 0) return null;
	const speed =
		activity.decodeMs > 0 ? Math.round(activity.decodeTokens / (activity.decodeMs / 1000)) : null;
	const rows: readonly (readonly [string, string])[] = [
		...(activity.llmMs > 0 ? ([["请求耗时", formatDuration(activity.llmMs)]] as const) : []),
		...(activity.toolMs > 0 ? ([["工具耗时", formatDuration(activity.toolMs)]] as const) : []),
		...(activity.ttftCount > 0
			? ([["首字延迟", formatDuration(Math.round(activity.ttftMs / activity.ttftCount))]] as const)
			: []),
		...(speed !== null ? ([["生成速度", `${speed} tok/s`]] as const) : []),
	];

	const label = (
		<span className="flex items-center gap-1">
			<span>
				{activity.turns} 轮 · {activity.steps} 步
			</span>
			{speed !== null ? <span className="text-foreground-subtlest">· {speed} tok/s</span> : null}
		</span>
	);
	if (rows.length === 0) {
		return (
			<Tooltip label="会话暂无计时数据">
				<span className={DOCK_PILL}>
					<Gauge className="size-3.5 shrink-0" />
					{label}
				</span>
			</Tooltip>
		);
	}
	return (
		<Popover
			trigger={({ toggle }) => (
				<button type="button" onClick={toggle} aria-label="活动统计" className={DOCK_PILL}>
					<Gauge className="size-3.5 shrink-0" />
					{label}
				</button>
			)}
		>
			<DetailRows rows={rows} />
		</Popover>
	);
}

/**
 * 用量胶囊：累计 token 与缓存命中率,点开看分项明细。
 *
 * 没有任何请求时不显示——空数字会被读成「用过但没花」,与事实不符。缓存命中率只统计输入侧
 * （未命中输入 + 缓存读 + 缓存写）,输出不经过缓存,不参与计算。
 */
function UsagePill({ usage }: { readonly usage: UsageSummary }): ReactElement | null {
	if (usage.requests === 0) return null;
	const inputSide = usage.input + usage.cacheRead + usage.cacheWrite;
	const hit = inputSide > 0 ? Math.round((usage.cacheRead / inputSide) * 100) : null;
	const rows: readonly (readonly [string, string])[] = [
		["请求", `${usage.requests} 次`],
		["输入", exactCount(usage.input)],
		...(usage.cacheRead > 0 ? ([["缓存读取", exactCount(usage.cacheRead)]] as const) : []),
		...(usage.cacheWrite > 0 ? ([["缓存写入", exactCount(usage.cacheWrite)]] as const) : []),
		["输出", exactCount(usage.output)],
		...(hit !== null ? ([["缓存命中率", `${hit}%`]] as const) : []),
		...(formatCost(usage.cost) !== undefined ? ([["累计费用", formatCost(usage.cost) ?? ""]] as const) : []),
	];

	return (
		<Popover
			trigger={({ toggle }) => (
				<button type="button" onClick={toggle} aria-label="用量统计" className={DOCK_PILL}>
					<Database className="size-3.5 shrink-0" />
					<span>{formatTokens(usage.total)}</span>
					{hit !== null ? <span className="text-foreground-subtlest">· 命中 {hit}%</span> : null}
				</button>
			)}
		>
			<DetailRows rows={rows} />
		</Popover>
	);
}

/** 上下文计:环形读数 + 百分比,点开看当前窗口占用。 */
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
	const size = 14;
	const stroke = 2;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;

	return (
		<Popover
			trigger={({ toggle }) => (
				<button type="button" onClick={toggle} aria-label="上下文占用" className={DOCK_PILL}>
					<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 shrink-0" aria-hidden="true">
						<circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
						<circle
							cx={size / 2}
							cy={size / 2}
							r={radius}
							fill="none"
							stroke="var(--business-blue)"
							strokeWidth={stroke}
							strokeLinecap="round"
							strokeDasharray={circumference}
							strokeDashoffset={circumference * (1 - ratio)}
						/>
					</svg>
					<span className="tabular-nums">{percent}%</span>
				</button>
			)}
		>
			<div className="w-56 px-2.5 py-2" aria-label="上下文占用">
				<div className="flex h-7 items-center justify-between text-[13px] leading-5">
					<span className="text-foreground-subtle">上下文已用 {percent}%</span>
					<span className="tabular-nums text-foreground">
						~{formatTokens(tokens)} / {formatTokens(contextWindow)}
					</span>
				</div>
				<div className="h-1 overflow-hidden rounded-full bg-[var(--border)]">
					<div className="h-full rounded-full bg-[var(--business-blue)]" style={{ width: `${percent}%` }} />
				</div>
			</div>
		</Popover>
	);
}

/** 胶囊浮层里的「名称 — 数值」行。 */
function DetailRows({ rows }: { readonly rows: readonly (readonly [string, string])[] }): ReactElement {
	return (
		<div className="w-56 px-2.5 py-2">
			{rows.map(([label, value]) => (
				<div key={label} className="flex h-7 items-center justify-between text-[13px] leading-5">
					<span className="text-foreground-subtle">{label}</span>
					<span className="tabular-nums text-foreground">{value}</span>
				</div>
			))}
		</div>
	);
}

/** 明细行用的精确计数:千分位分组,与胶囊上的缩写互补。 */
function exactCount(value: number): string {
	return value.toLocaleString("en-US");
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}
