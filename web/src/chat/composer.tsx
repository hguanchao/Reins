import {
	ArrowUp,
	AtSign,
	ChevronDown,
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
import { Menu, Tooltip, cn, toast, type MenuEntry } from "../components/ui/index.ts";
import type { ApprovalMode, ModelInfo, SettingsModel, SkillInfo, ThinkingLevel } from "../protocol.ts";

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
									className="flex h-7 max-w-[150px] items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
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
						<ContextUsage tokens={props.contextTokens} window={props.contextWindow} />

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
									className="flex h-7 max-w-[220px] items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
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
		</div>
	);
}

function ContextUsage({
	tokens,
	window: contextWindow,
}: {
	readonly tokens: number | undefined;
	readonly window: number | undefined;
}): ReactElement | null {
	if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return null;
	const ratio = Math.min(1, tokens / contextWindow);
	const size = 18;
	const stroke = 2;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const label = `上下文 ${formatTokens(tokens)} / ${formatTokens(contextWindow)}（${Math.round(ratio * 100)}%）`;

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
						stroke="var(--business-blue)"
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
