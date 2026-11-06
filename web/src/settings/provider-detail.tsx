import { Check, Eye, EyeOff, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";

import { api as apiClient } from "../api.ts";
import { formatTokens } from "../lib/format.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import type { ProviderInput, ProviderModel, ProviderView, ThinkingLevel } from "../protocol.ts";
import { ChoiceGroup } from "./controls.tsx";
import { ModelDialog } from "./model-dialog.tsx";

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

const FIELD =
	"flex h-8 w-full items-center gap-2 rounded-md border-[0.5px] border-input-border bg-input px-2.5 transition-colors focus-within:border-input-border-focused";
const INPUT =
	"min-w-0 flex-1 bg-transparent text-[12px] leading-[18px] outline-none placeholder:text-foreground-subtlest";

/** 提供方详情：基础配置与模型列表，改动后需要保存才写回。 */
export function ProviderDetail({
	provider,
	current,
	effort,
	levels,
	onToggleEnabled,
	onSelectModel,
	onUpdate,
	onSaved,
	onDeleted,
}: {
	readonly provider: ProviderView;
	/** 当前正在使用的模型，用于标记「使用中」 */
	readonly current: { readonly provider: string; readonly model: string } | undefined;
	readonly effort: ThinkingLevel;
	/** 当前模型支持的思考等级；为空时不展示该行 */
	readonly levels: readonly ThinkingLevel[];
	onToggleEnabled(enabled: boolean): void;
	onSelectModel(provider: string, model: string): void;
	onUpdate(update: { effort?: ThinkingLevel }): void;
	onSaved(id: string): void;
	onDeleted(): void;
}): ReactElement {
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
	const [api, setApi] = useState(provider.api ?? "");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<readonly ProviderModel[]>(provider.models);
	const [showKey, setShowKey] = useState(false);
	const [dialog, setDialog] = useState<{ readonly index: number | undefined } | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const dirty =
		baseUrl !== (provider.baseUrl ?? "") ||
		api !== (provider.api ?? "") ||
		apiKey.trim().length > 0 ||
		JSON.stringify(models) !== JSON.stringify(provider.models);

	const reset = (): void => {
		setBaseUrl(provider.baseUrl ?? "");
		setApi(provider.api ?? "");
		setApiKey("");
		setModels(provider.models);
		setError(undefined);
	};

	const submit = (): void => {
		if (saving) return;
		setSaving(true);
		setError(undefined);
		const input: ProviderInput = {
			id: provider.id,
			name: provider.name,
			baseUrl: baseUrl.trim(),
			api,
			headers: provider.headers,
			promptCacheKey: provider.promptCacheKey,
			enabled: provider.enabled,
			models,
			...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
		};
		void apiClient
			.saveProvider(input)
			.then(() => {
				toast("提供方已保存");
				setApiKey("");
				onSaved(provider.id);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	const usingHere = current?.provider === provider.id;

	return (
		<div className="flex min-h-full flex-col gap-3">
			<div className="flex items-center gap-2">
				<span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface text-foreground-subtle">
					<Pencil className="size-2.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-[14px] leading-5 font-semibold">
					{provider.name}
				</span>
				{error === undefined ? null : (
					<span className="shrink-0 text-[11px] leading-4 text-destructive">{error}</span>
				)}
				{dirty ? (
					<>
						<button
							type="button"
							onClick={reset}
							className="shrink-0 text-[12px] leading-[18px] text-foreground-subtle hover:text-foreground"
						>
							撤销
						</button>
						<Button variant="primary" size="sm" disabled={saving} onClick={submit}>
							{saving ? "保存中…" : "保存"}
						</Button>
					</>
				) : null}
				<button
					type="button"
					role="switch"
					aria-checked={provider.enabled}
					aria-label={`启用 ${provider.name}`}
					onClick={() => onToggleEnabled(!provider.enabled)}
					className={cn(
						"relative h-[19px] w-8 shrink-0 rounded-full border-[0.5px] transition-colors",
						provider.enabled ? "border-primary bg-primary" : "border-border bg-surface-strong",
					)}
				>
					<span
						className={cn(
							"absolute top-[1.5px] size-[13px] rounded-full bg-card shadow-sm transition-[left]",
							provider.enabled ? "left-[16px]" : "left-[2px]",
						)}
					/>
				</button>
				<DeleteButton provider={provider} onDeleted={onDeleted} />
			</div>

			<label className="flex flex-col gap-1">
				<span className="text-[12px] leading-[18px] text-foreground-subtle">Base URL</span>
				<span className={FIELD}>
					<input
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						placeholder="https://api.example.com/v1"
						aria-label="Base URL"
						className={cn(INPUT, "font-mono")}
					/>
				</span>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-[12px] leading-[18px] text-foreground-subtle">API 格式</span>
				<span className={FIELD}>
					<select
						value={api}
						onChange={(event) => setApi(event.target.value)}
						aria-label="API 格式"
						className={cn(INPUT, "cursor-pointer")}
					>
						{["openai-completions", "openai-responses", "anthropic-messages"].map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
				</span>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-[12px] leading-[18px] text-foreground-subtle">API Key</span>
				<span className={FIELD}>
					<input
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						type={showKey ? "text" : "password"}
						placeholder={provider.hasApiKey ? "已保存，留空保持不变" : "输入 API Key"}
						aria-label="API Key"
						className={cn(INPUT, "font-mono")}
					/>
					<button
						type="button"
						aria-label={showKey ? "隐藏密钥" : "显示密钥"}
						onClick={() => setShowKey((value) => !value)}
						className="shrink-0 text-foreground-subtlest hover:text-foreground"
					>
						{showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
					</button>
				</span>
			</label>

			<div className="mt-2 flex items-center justify-between">
				<span className="text-[12px] leading-[18px] text-foreground-subtle">模型列表</span>
				<Button
					variant="outline"
					size="sm"
					className="h-6 rounded-md px-2 text-[12px]"
					onClick={() => setDialog({ index: undefined })}
				>
					<Plus className="size-3" />
					添加模型
				</Button>
			</div>

			{models.length === 0 ? (
				<div className="flex h-13 items-center justify-center rounded-lg border-[0.5px] border-dashed border-border text-[12px] leading-[18px] text-foreground-subtle">
					当前没有配置模型，添加模型后可在聊天中使用。
				</div>
			) : (
				<div className="flex flex-col overflow-hidden rounded-lg border-[0.5px] border-border">
					{models.map((model, index) => {
						const active = usingHere && current?.model === model.id;
						return (
							<div
								key={model.id}
								className={cn(
									"flex items-center gap-2 border-b-[0.5px] border-border px-2.5 py-1.5 last:border-b-0",
									active ? "bg-card-selected" : "hover:bg-surface-hover",
								)}
							>
								<button
									type="button"
									onClick={() => onSelectModel(provider.id, model.id)}
									className="flex min-w-0 flex-1 items-center gap-2 text-left"
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13px] leading-5">{model.name}</span>
										<span className="block truncate font-mono text-[10.5px] leading-4 text-foreground-subtlest">
											{model.id}
										</span>
									</span>
									<span className="shrink-0 font-mono text-[10.5px] leading-4 text-foreground-subtlest">
										{model.contextWindow === undefined ? "—" : `ctx ${formatTokens(model.contextWindow)}`}
									</span>
									<span
										className={cn(
											"flex w-14 shrink-0 items-center justify-end gap-1 text-[11px] leading-4",
											active ? "font-medium text-foreground" : "text-foreground-subtlest",
										)}
									>
										{active ? (
											<>
												<Check className="size-3" strokeWidth={3} />
												使用中
											</>
										) : (
											"使用"
										)}
									</span>
								</button>
								<button
									type="button"
									aria-label={`编辑模型 ${model.id}`}
									title="编辑模型"
									onClick={() => setDialog({ index })}
									className="ml-1 shrink-0 border-l-[0.5px] border-border pl-2 text-foreground-subtlest hover:text-foreground"
								>
									<Pencil className="size-3" />
								</button>
							</div>
						);
					})}
				</div>
			)}

			{levels.length === 0 ? null : (
				<div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t-[0.5px] border-border pt-3">
					<span className="flex flex-col">
						<span className="text-[12px] leading-[18px]">思考等级</span>
						<span className="text-[11px] leading-4 text-foreground-subtlest">
							当前模型支持的等级，关闭表示不发送思考参数。
						</span>
					</span>
					<ChoiceGroup
						options={levels.map((level) => ({ key: level, label: EFFORT_LABELS[level] }))}
						selected={effort}
						onSelect={(next) => onUpdate({ effort: next })}
					/>
				</div>
			)}

			<ModelDialog
				open={dialog !== undefined}
				model={dialog?.index === undefined ? undefined : models[dialog.index]}
				existingIds={models
					.filter((_, position) => position !== dialog?.index)
					.map((model) => model.id)}
				patch={{ api, baseUrl }}
				onClose={() => setDialog(undefined)}
				onSubmit={(next) => {
					setModels((list) => {
						if (dialog?.index === undefined) return [...list, next];
						return list.map((model, position) => (position === dialog.index ? next : model));
					});
					setDialog(undefined);
				}}
			/>
		</div>
	);
}

/** 删除按钮独立成组件，确认弹层与列表项解耦。 */
function DeleteButton({
	provider,
	onDeleted,
}: {
	readonly provider: ProviderView;
	onDeleted(): void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const remove = (): void => {
		if (busy) return;
		setBusy(true);
		void apiClient
			.deleteProvider(provider.id)
			.then(() => {
				toast("提供方已删除");
				setOpen(false);
				onDeleted();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setBusy(false));
	};

	return (
		<>
			<button
				type="button"
				aria-label="更多"
				onClick={() => setOpen(true)}
				className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
			>
				<MoreHorizontal className="size-3.5" />
			</button>
			<Dialog
				open={open}
				onClose={() => setOpen(false)}
				title="删除提供方"
				footer={
					<>
						<Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(false)}>
							取消
						</Button>
						<Button variant="danger" size="sm" disabled={busy} onClick={remove}>
							<Trash2 className="size-3.5" />
							{busy ? "删除中…" : "删除"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">删除后 providers.json 中的这项配置会移除，不能撤销。</p>
					<p className="m-0 text-foreground">{provider.name}</p>
					{error === undefined ? null : <p className="m-0 text-destructive">{error}</p>}
				</div>
			</Dialog>
		</>
	);
}

/** 供外部构造新提供方时复用的空模型。 */
export function emptyModel(api: string, baseUrl: string): ProviderModel {
	return {
		id: "",
		name: "",
		api,
		baseUrl,
		reasoning: false,
		thinkingLevelMap: {},
		input: ["text"],
		cost: undefined,
		contextWindow: undefined,
		maxTokens: undefined,
		maxTokensField: "max_tokens",
		headers: {},
	};
}
