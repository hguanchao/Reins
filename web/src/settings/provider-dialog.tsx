import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { api as apiClient } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";
import type { ProviderInput, ProviderModel, ProviderView } from "../protocol.ts";

const FIELD =
	"h-9 w-full rounded-md border-[0.5px] border-input-border bg-input px-3 text-[13px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";
const SMALL_FIELD =
	"h-8 w-full rounded-md border-[0.5px] border-input-border bg-input px-2.5 text-[12px] leading-[18px] outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

/** 新增或编辑提供方；模型列表保留高级字段，表单只改常用项。 */
export function ProviderDialog({
	open,
	provider,
	onClose,
	onSaved,
}: {
	readonly open: boolean;
	readonly provider: ProviderView | undefined;
	onClose(): void;
	onSaved(): void;
}): ReactElement {
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<readonly ProviderModel[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!open) return;
		setId(provider?.id ?? "");
		setName(provider?.name ?? "");
		setBaseUrl(provider?.baseUrl ?? "");
		setApi(provider?.api ?? "openai-completions");
		setApiKey("");
		setModels(
			provider === undefined
				? [emptyModel("openai-completions", "")]
				: provider.models.map((model) => ({
						...model,
						thinkingLevelMap: { ...model.thinkingLevelMap },
						input: [...model.input],
						headers: { ...model.headers },
					})),
		);
		setSaving(false);
		setError(undefined);
	}, [open, provider]);

	const updateModel = (index: number, patch: Partial<ProviderModel>): void => {
		setModels((current) =>
			current.map((model, position) => (position === index ? { ...model, ...patch } : model)),
		);
	};

	const submit = (): void => {
		if (saving) return;
		const trimmedId = id.trim();
		const trimmedName = name.trim();
		if (trimmedId.length === 0 || trimmedName.length === 0) {
			setError("请填写提供方 ID 与名称");
			return;
		}
		if (models.length === 0) {
			setError("至少需要一个模型");
			return;
		}
		const seen = new Set<string>();
		for (const model of models) {
			const modelId = model.id.trim();
			if (modelId.length === 0) {
				setError("模型 ID 不能为空");
				return;
			}
			if (seen.has(modelId)) {
				setError(`模型 ID ${modelId} 重复`);
				return;
			}
			seen.add(modelId);
		}

		const input: ProviderInput = {
			id: trimmedId,
			name: trimmedName,
			baseUrl: baseUrl.trim(),
			api,
			...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
			headers: provider?.headers ?? {},
			promptCacheKey: provider?.promptCacheKey ?? false,
			models: models.map((model) => ({
				...model,
				id: model.id.trim(),
				name: model.name.trim().length === 0 ? model.id.trim() : model.name.trim(),
				api:
					model.api.trim().length === 0 || model.api === provider?.api
						? api
						: model.api,
				baseUrl:
					model.baseUrl.trim().length === 0 || model.baseUrl === provider?.baseUrl
						? baseUrl.trim()
						: model.baseUrl,
			})),
		};

		setSaving(true);
		setError(undefined);
		void apiClient
			.saveProvider(input)
			.then(() => {
				toast("提供方已保存");
				onSaved();
				onClose();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	const apiOptions = APIS.includes(api as (typeof APIS)[number])
		? [...APIS]
		: [...APIS, api];

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title={provider === undefined ? "添加提供方" : "编辑提供方"}
			className="max-w-[720px]!"
			footer={
				<>
					<Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" disabled={saving} onClick={submit}>
						{saving ? "保存中…" : "保存"}
					</Button>
				</>
			}
		>
			<div className="flex max-h-[calc(100vh-220px)] flex-col gap-4 overflow-y-auto pr-1">
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="flex flex-col gap-1">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">提供方 ID</span>
						<input
							value={id}
							onChange={(event) => setId(event.target.value)}
							disabled={provider !== undefined}
							placeholder="openai"
							aria-label="提供方 ID"
							autoFocus={provider === undefined}
							className={FIELD}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">显示名称</span>
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="OpenAI"
							aria-label="提供方名称"
							className={FIELD}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">协议</span>
						<select
							value={api}
							onChange={(event) => setApi(event.target.value)}
							aria-label="提供方协议"
							className={FIELD}
						>
							{apiOptions.map((option) => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">Base URL</span>
						<input
							value={baseUrl}
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder="https://api.example.com/v1"
							aria-label="Base URL"
							className={FIELD}
						/>
					</label>
				</div>

				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">API Key</span>
					<input
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						type="password"
						placeholder={provider?.hasApiKey === true ? "已保存，留空保持不变" : "可留空"}
						aria-label="API Key"
						className={FIELD}
					/>
				</label>

				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">模型</span>
						<Button
							variant="outline"
							size="sm"
							className="h-7 rounded-md px-2.5 text-[12px]"
							onClick={() => setModels((current) => [...current, emptyModel(api, baseUrl)])}
						>
							<Plus className="size-3.5" />
							添加模型
						</Button>
					</div>
					<div className="flex flex-col gap-2">
						{models.map((model, index) => (
							<div
								key={index}
								className="rounded-xl border-[0.5px] border-border bg-card p-3"
							>
								<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
									<input
										value={model.id}
										onChange={(event) => updateModel(index, { id: event.target.value })}
										placeholder="模型 ID，如 deepseek-chat"
										aria-label={`模型 ID ${index + 1}`}
										className={SMALL_FIELD}
									/>
									<input
										value={model.name}
										onChange={(event) => updateModel(index, { name: event.target.value })}
										placeholder="显示名称"
										aria-label={`模型名称 ${index + 1}`}
										className={SMALL_FIELD}
									/>
									<button
										type="button"
										aria-label="删除模型"
										title="删除模型"
										disabled={models.length <= 1}
										onClick={() =>
											setModels((current) => current.filter((_, position) => position !== index))
										}
										className="flex size-8 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-destructive-surface hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
									>
										<Trash2 className="size-3.5" />
									</button>
								</div>
								<div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_1fr]">
									<label className="flex h-8 items-center gap-1.5 text-[12px] leading-[18px] text-foreground-subtle">
										<input
											type="checkbox"
											checked={model.reasoning}
											onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
											className="size-3.5 accent-(--accent)"
										/>
										思考
									</label>
									<input
										value={model.contextWindow === undefined ? "" : String(model.contextWindow)}
										onChange={(event) =>
											updateModel(index, {
												contextWindow: parsePositive(event.target.value),
											})
										}
										inputMode="numeric"
										placeholder="上下文窗口"
										aria-label={`上下文窗口 ${index + 1}`}
										className={SMALL_FIELD}
									/>
									<input
										value={model.maxTokens === undefined ? "" : String(model.maxTokens)}
										onChange={(event) =>
											updateModel(index, { maxTokens: parsePositive(event.target.value) })
										}
										inputMode="numeric"
										placeholder="最大输出"
										aria-label={`最大输出 ${index + 1}`}
										className={SMALL_FIELD}
									/>
								</div>
							</div>
						))}
					</div>
				</div>

				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}

function emptyModel(api: string, baseUrl: string): ProviderModel {
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

function parsePositive(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
