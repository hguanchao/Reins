import {
	ArrowUp,
	Bot,
	Check,
	ChevronDown,
	Map as MapIcon,
	Plus,
	Settings2,
	Sparkles,
	Square,
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
import { Button, IconButton, Menu, Popover, Switch, Tooltip, cn, toast } from "../components/ui/index.ts";
import type {
	ApprovalMode,
	ModelInfo,
	SettingsModel,
	SkillInfo,
	ThinkingLevel,
} from "../protocol.ts";

const MAX_INPUT_HEIGHT = 168;

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

/** 输入卡：编辑、@ 文件 / $ 技能提及、模式与模型控制、发送/停止。 */
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

		// 输入框为空或光标在开头时，上下键翻历史
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

	return (
		<div className="relative w-full">
			{suggestion !== undefined && suggestion.items.length > 0 ? (
				<div className="absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-xl border border-popover-border bg-popover p-1 shadow-md animate-pop">
					{suggestion.items.map((item, index) => (
						<button
							key={item}
							type="button"
							onMouseDown={(event) => {
								event.preventDefault();
								insertMention(item);
							}}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-base",
								index === suggestion.index ? "bg-menu-hover text-foreground" : "text-foreground-subtle",
							)}
						>
							{suggestion.kind === "file" ? (
								<Wrench className="size-3.5 shrink-0" />
							) : (
								<Sparkles className="size-3.5 shrink-0" />
							)}
							<span className="min-w-0 truncate font-mono text-ui-sm">{item}</span>
						</button>
					))}
				</div>
			) : null}

			<div className="composer-shell flex flex-col gap-3 overflow-hidden rounded-2xl border-[0.5px] border-input-border bg-input p-3 shadow-composer-soft transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
					<textarea
						ref={textareaRef}
						value={text}
						onChange={onChange}
						onKeyDown={onKeyDown}
						rows={1}
						placeholder={props.running ? "正在回复…" : "给 Reins 一个任务，@ 文件，$ 技能"}
						className="max-h-42 min-h-10 w-full resize-none bg-transparent text-ui-base leading-6 text-foreground outline-none placeholder:text-foreground-subtlest"
						aria-label="输入消息"
					/>

					<div className="group/toolbar flex flex-wrap items-end gap-3 gap-y-2">
					<div className="flex items-center gap-1">
						<Menu
							trigger={({ toggle }) => (
								<IconButton label="更多操作" size="icon" onClick={toggle}>
									<Plus className="size-4" />
								</IconButton>
							)}
							entries={[
								{ type: "item", key: "new", label: "新任务", icon: Plus, onSelect: props.onNewTask },
								{ type: "item", key: "settings", label: "设置", icon: Settings2, onSelect: props.onSettings },
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

						<ModeControl {...props} />
					</div>

					<div className="ml-auto flex items-center gap-1.5">
						<ContextUsage tokens={props.contextTokens} window={props.contextWindow} />
						<ModelSelect {...props} models={props.models} current={currentModel} />
						<EffortSelect
							effort={props.effort}
							levels={effortLevels}
							onEffort={props.onEffort}
						/>
						{props.running ? (
							<Button
								size="icon"
								variant="secondary"
								className="gap-1 rounded-full bg-brand text-foreground-inverse hover:opacity-80"
								aria-label="停止"
								title="停止 (Esc)"
								onClick={props.onStop}
							>
								<Square className="size-3.5 fill-current" />
							</Button>
						) : (
							<Button
								size="icon"
								variant="primary"
								className="gap-1 rounded-full bg-brand text-foreground-inverse hover:opacity-80"
								aria-label="发送"
								title="发送 (Enter)"
								disabled={text.trim().length === 0}
								onClick={submit}
							>
								<ArrowUp className="size-4" />
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function ModeControl(props: ComposerProps): ReactElement {
	return (
		<Popover
			trigger={({ toggle }) => (
				<Button
					variant="ghost"
					size="sm"
					onClick={toggle}
					className="h-7 gap-1 rounded-lg px-2 text-ui-base"
					aria-label="模式与审批"
				>
					{props.planMode ? <MapIcon className="size-4" /> : <Bot className="size-4" />}
					<span>{props.planMode ? "Plan" : "Agent"}</span>
					<span className="text-ui-sm text-foreground-subtle">{APPROVAL_LABELS[props.approvalMode]}</span>
					<ChevronDown className="size-3.5 text-foreground-subtlest" />
				</Button>
			)}
			className="w-64"
		>
			<div className="flex flex-col gap-1 p-1">
				<div className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2">
					<div className="min-w-0">
						<div className="text-ui-base font-medium">Plan 模式</div>
						<div className="text-ui-sm text-foreground-subtle">只读规划，不改动任何文件</div>
					</div>
					<Switch
						checked={props.planMode}
						onCheckedChange={props.onPlanMode}
						label="Plan 模式"
					/>
				</div>
				<div className="h-px bg-border" />
				<div className="px-2.5 pb-1 pt-1.5 text-ui-xs font-medium text-foreground-subtlest">审批方式</div>
				{(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
					<button
						key={mode}
						type="button"
						onClick={() => props.onApprovalMode(mode)}
						className={cn(
							"flex min-h-8 items-center gap-2 rounded-xl px-2.5 text-left text-ui-base transition-colors",
							mode === props.approvalMode ? "bg-selected text-foreground" : "text-foreground-subtle hover:bg-surface-hover",
						)}
					>
						<span className="min-w-0 flex-1">{APPROVAL_LABELS[mode]}</span>
						{mode === props.approvalMode ? <Check className="size-4" /> : null}
					</button>
				))}
			</div>
		</Popover>
	);
}

function ModelSelect(
	props: ComposerProps & { readonly models: readonly SettingsModel[]; readonly current: SettingsModel | undefined },
): ReactElement {
	const grouped = useMemo(() => {
		const groups = new Map<string, SettingsModel[]>();
		for (const model of props.models) {
			const list = groups.get(model.providerName) ?? [];
			list.push(model);
			groups.set(model.providerName, list);
		}
		return [...groups.entries()];
	}, [props.models]);

	return (
		<Popover
			trigger={({ toggle }) => (
				<Button
					variant="ghost"
					size="sm"
					onClick={toggle}
					className="h-7 max-w-44 gap-1 rounded-lg px-2 text-ui-base"
					aria-label="选择模型"
				>
					<span className="truncate">{props.model.name}</span>
					<ChevronDown className="size-3.5 shrink-0 text-foreground-subtlest" />
				</Button>
			)}
			className="max-h-80 w-72 overflow-y-auto"
		>
			{grouped.length === 0 ? (
				<div className="px-2 py-3 text-ui-sm text-foreground-subtle">没有可用模型</div>
			) : (
				grouped.map(([providerName, models]) => (
					<div key={providerName} className="mb-1 last:mb-0">
						<div className="px-2 py-1 text-ui-xs font-medium text-foreground-subtlest">{providerName}</div>
						{models.map((model) => {
							const active = model.provider === props.model.provider && model.model === props.model.model;
							return (
								<button
									key={`${model.provider}/${model.model}`}
									type="button"
									onClick={() => props.onModel(model.provider, model.model)}
									className={cn(
										"flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base transition-colors",
										active
											? "bg-selected text-foreground"
											: "text-foreground-subtle hover:bg-surface-hover",
									)}
								>
									<span className="min-w-0 flex-1 truncate">{model.name}</span>
									{model.contextWindow === undefined ? null : (
										<span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
											{formatTokens(model.contextWindow)}
										</span>
									)}
									{active ? <Check className="size-4 shrink-0" /> : null}
								</button>
							);
						})}
					</div>
				))
			)}
		</Popover>
	);
}

function EffortSelect({
	effort,
	levels,
	onEffort,
}: {
	readonly effort: ThinkingLevel;
	readonly levels: readonly ThinkingLevel[];
	readonly onEffort: (effort: ThinkingLevel) => void;
}): ReactElement {
	const disabled = levels.length <= 1;
	return (
		<Menu
			trigger={({ toggle }) => (
				<Button
					variant="ghost"
					size="sm"
					onClick={toggle}
					disabled={disabled}
					className="h-7 gap-1 rounded-lg px-2 text-ui-base"
					aria-label="思考等级"
				>
					<Sparkles className="size-3.5 text-foreground-subtlest" />
					<span>{EFFORT_LABELS[effort]}</span>
					<ChevronDown className="size-3.5 text-foreground-subtlest" />
				</Button>
			)}
			entries={levels.map((level) => ({
				type: "item" as const,
				key: level,
				label: `思考：${EFFORT_LABELS[level]}`,
				checked: level === effort,
				onSelect: () => onEffort(level),
			}))}
		/>
	);
}

function ContextUsage({
	tokens,
	window,
}: {
	readonly tokens: number | undefined;
	readonly window: number | undefined;
}): ReactElement {
	const ratio = tokens !== undefined && window !== undefined && window > 0 ? Math.min(1, tokens / window) : 0;
	const size = 18;
	const stroke = 2;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const label =
		tokens === undefined || window === undefined
			? "上下文用量未知"
			: `上下文 ${formatTokens(tokens)} / ${formatTokens(window)}（${Math.round(ratio * 100)}%）`;

	return (
		<Tooltip label={label}>
			<span className="inline-flex size-7 items-center justify-center">
				<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
					<circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
					<circle
						cx={size / 2}
						cy={size / 2}
						r={radius}
						fill="none"
						stroke="var(--brand)"
						strokeWidth={stroke}
						strokeLinecap="round"
						strokeDasharray={circumference}
						strokeDashoffset={circumference * (1 - ratio)}
					/>
				</svg>
			</span>
		</Tooltip>
	);
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}
