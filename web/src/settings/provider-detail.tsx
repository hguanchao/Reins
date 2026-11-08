import { Check, ChevronDown, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";

import { api as apiClient } from "../api.ts";
import { Dialog, toast } from "../components/ui/index.ts";
import { formatTokens } from "../lib/format.ts";
import type { ProviderInput, ProviderModel, ProviderView, ThinkingLevel } from "../protocol.ts";
import { ModelDialog } from "./model-dialog.tsx";

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

/** 请求头编辑框的文本形态：每行一条「名称: 值」。 */
function serializeHeaders(headers: Record<string, string>): string {
	return Object.entries(headers)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
}

/** 请求头解析：整块 JSON 对象，或每行一条「名称: 值」；两者都不像就报错，不静默丢弃。 */
function parseHeaders(text: string): Record<string, string> | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return {};
	if (trimmed.startsWith("{")) {
		try {
			const value: unknown = JSON.parse(trimmed);
			if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
			const result: Record<string, string> = {};
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
				if (typeof item !== "string") return undefined;
				result[key] = item;
			}
			return result;
		} catch {
			return undefined;
		}
	}
	const result: Record<string, string> = {};
	for (const line of trimmed.split("\n")) {
		const cut = line.indexOf(":");
		if (cut <= 0) return undefined;
		const key = line.slice(0, cut).trim();
		if (key.length === 0) return undefined;
		result[key] = line.slice(cut + 1).trim();
	}
	return result;
}

/** API 格式：三种协议与产品实现一一对应，选中项后跟等宽路径。 */
const API_FORMATS: readonly { readonly key: string; readonly name: string; readonly path: string }[] = [
	{ key: "anthropic-messages", name: "Anthropic Messages", path: "/v1/messages" },
	{ key: "openai-completions", name: "Chat Completions", path: "/chat/completions" },
	{ key: "openai-responses", name: "Responses", path: "/responses" },
];

/**
 * 供应商详情。
 *
 * 全部字段可编辑：名称是标题位上的输入框（不是只读文本），改名字实时同步左栏；Base URL、
 * API 格式、API Key、模型都能改。API 格式用与字段同宽的自绘菜单，不用原生 select。
 */
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
	readonly current: { readonly provider: string; readonly model: string } | undefined;
	readonly effort: ThinkingLevel;
	readonly levels: readonly ThinkingLevel[];
	onToggleEnabled(enabled: boolean): void;
	onSelectModel(provider: string, model: string): void;
	onUpdate(update: { effort?: ThinkingLevel }): void;
	onSaved(id: string): void;
	onDeleted(): void;
}): ReactElement {
	const [name, setName] = useState(provider.name);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
	const [api, setApi] = useState(provider.api ?? "anthropic-messages");
	const [apiKey, setApiKey] = useState("");
	const [headersText, setHeadersText] = useState(() => serializeHeaders(provider.headers));
	const [models, setModels] = useState<readonly ProviderModel[]>(provider.models);
	const [showKey, setShowKey] = useState(false);
	const [apiOpen, setApiOpen] = useState(false);
	const [dialog, setDialog] = useState<{ readonly index: number | undefined } | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const dirty =
		name.trim() !== provider.name ||
		baseUrl !== (provider.baseUrl ?? "") ||
		api !== (provider.api ?? "") ||
		apiKey.trim().length > 0 ||
		headersText.trim() !== serializeHeaders(provider.headers).trim() ||
		JSON.stringify(models) !== JSON.stringify(provider.models);

	const reset = (): void => {
		setName(provider.name);
		setBaseUrl(provider.baseUrl ?? "");
		setApi(provider.api ?? "anthropic-messages");
		setApiKey("");
		setHeadersText(serializeHeaders(provider.headers));
		setModels(provider.models);
		setError(undefined);
		setStatus("");
	};

	const submit = (): void => {
		if (saving) return;
		const headers = parseHeaders(headersText);
		if (headers === undefined) {
			setError("请求头格式不对：用 JSON 对象，或每行一条「名称: 值」");
			return;
		}
		setSaving(true);
		setError(undefined);
		const input: ProviderInput = {
			id: provider.id,
			name: name.trim().length === 0 ? provider.name : name.trim(),
			baseUrl: baseUrl.trim(),
			api,
			headers,
			promptCacheKey: provider.promptCacheKey,
			enabled: provider.enabled,
			models,
			...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
		};
		void apiClient
			.saveProvider(input)
			.then(() => {
				setApiKey("");
				setStatus("已保存");
				window.setTimeout(() => setStatus(""), 2000);
				onSaved(provider.id);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	const remove = (): void => {
		void apiClient
			.deleteProvider(provider.id)
			.then(() => {
				toast("供应商已删除");
				setConfirmDelete(false);
				onDeleted();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	};

	const usingHere = current?.provider === provider.id;
	const format = API_FORMATS.find((item) => item.key === api) ?? API_FORMATS[0];

	return (
		<>
			<div className="pd-h">
				<div className="tx">
					<div className="n">
						<input
							className="name-input"
							value={name}
							onChange={(event) => setName(event.target.value)}
							aria-label="供应商名称"
							spellCheck={false}
						/>
						<span className="badge">{provider.enabled ? "已启用" : "已停用"}</span>
					</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={provider.enabled}
					aria-label={`${provider.enabled ? "停用" : "启用"} ${provider.name}`}
					className="sw"
					onClick={() => onToggleEnabled(!provider.enabled)}
				>
					<i />
				</button>
			</div>

			<div className="field">
				<div className="fl">Base URL</div>
				<div className="input-line">
					<input
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						placeholder="https://api.example.com/v1"
						aria-label="Base URL"
						spellCheck={false}
					/>
				</div>
			</div>

			<div className="field" style={{ position: "relative" }}>
				<div className="fl">API 格式</div>
				<button
					type="button"
					className="input-line"
					style={{ width: "100%", cursor: "pointer" }}
					aria-expanded={apiOpen}
					aria-haspopup="listbox"
					onClick={() => setApiOpen((value) => !value)}
				>
					<span className="t">{format?.name ?? api}</span>
					<span className="p">{format?.path}</span>
					<ChevronDown className="ic ic-12 chev" />
				</button>
				{apiOpen ? (
					<div
						className="pop animate-pop"
						role="listbox"
						style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: "100%", zIndex: 30 }}
					>
						{API_FORMATS.map((item) => (
							<button
								key={item.key}
								type="button"
								role="option"
								aria-selected={item.key === api}
								className="pop-i"
								style={item.key === api ? { background: "var(--wash-2)" } : undefined}
								onClick={() => {
									setApi(item.key);
									setApiOpen(false);
								}}
							>
								<span className="min-w-0 flex-1 truncate">{item.name}</span>
								<span
									style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-10)", color: "var(--ink-4)" }}
								>
									{item.path}
								</span>
								{item.key === api ? <Check className="ic ic-12 ck" /> : null}
							</button>
						))}
						<div className="pop-sep" />
						<div
							style={{
								padding: "7px 10px 3px",
								fontSize: "var(--fs-10)",
								lineHeight: 1.55,
								color: "var(--ink-4)",
							}}
						>
							格式决定请求体与路径；切换后请确认 Base URL 是否匹配。
						</div>
					</div>
				) : null}
			</div>

			<div className="field">
				<div className="fl">API Key</div>
				<div className="input-line">
					<input
						type={showKey ? "text" : "password"}
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={provider.hasApiKey ? "已保存，留空保持不变" : "留空则不发送凭据"}
						aria-label="API Key"
						spellCheck={false}
						autoComplete="off"
					/>
					<button
						type="button"
						className="eye"
						onClick={() => setShowKey((value) => !value)}
						title={showKey ? "隐藏密钥" : "显示密钥"}
						aria-label={showKey ? "隐藏密钥" : "显示密钥"}
					>
						{showKey ? <EyeOff className="ic ic-14" /> : <Eye className="ic ic-14" />}
					</button>
				</div>
			</div>

			<div className="field">
				<div className="fl">请求头</div>
				<textarea
					className="form-area"
					style={{ minHeight: 56 }}
					value={headersText}
					onChange={(event) => setHeadersText(event.target.value)}
					placeholder={"X-Custom-Header: value\n支持 JSON 对象，或每行一条「名称: 值」"}
					aria-label="请求头"
					spellCheck={false}
				/>
				<div className="hint">随每次请求发送给这个供应商；留空表示没有额外请求头。</div>
			</div>

			<div className="field">
				<div className="model-head">
					<div className="fl">模型列表</div>
					<button type="button" className="m-add" onClick={() => setDialog({ index: undefined })}>
						<Plus className="ic ic-12" />
						添加模型
					</button>
				</div>
				<div className="model-list">
					{models.length === 0 ? (
						<div className="model-empty">当前没有配置模型，添加后可在聊天中使用</div>
					) : (
						models.map((model, index) => {
							const active = usingHere && current?.model === model.id;
							return (
								<div key={model.id} className="model-row">
									<span
										role="radio"
										aria-checked={active}
										aria-label={`使用 ${model.name}`}
										className="rd"
										tabIndex={0}
										onClick={() => onSelectModel(provider.id, model.id)}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") onSelectModel(provider.id, model.id);
										}}
									/>
									<span className="mn">{model.name}</span>
									<span className="ms">
										{model.contextWindow === undefined ? "—" : formatTokens(model.contextWindow)}
									</span>
									{active ? <span className="badge">当前</span> : null}
									<span className="mrow-acts">
										<button
											type="button"
											className="mrow-ico"
											aria-label={`编辑模型 ${model.id}`}
											title="编辑模型"
											onClick={() => setDialog({ index })}
										>
											<Pencil className="ic ic-12" />
										</button>
										<button
											type="button"
											className="mrow-ico"
											aria-label={`删除模型 ${model.id}`}
											title="删除模型"
											onClick={() =>
												setModels((list) => list.filter((_, position) => position !== index))
											}
										>
											<Trash2 className="ic ic-12" />
										</button>
									</span>
								</div>
							);
						})
					)}
				</div>
			</div>

			{levels.length === 0 ? null : (
				<div className="field">
					<div className="fl">思考强度</div>
					<div className="seg">
						{levels.map((level) => (
							<button
								key={level}
								type="button"
								aria-pressed={level === effort}
								onClick={() => onUpdate({ effort: level })}
							>
								{EFFORT_LABELS[level]}
							</button>
						))}
					</div>
				</div>
			)}

			<div className="pd-f">
				<button
					type="button"
					className="b b-ghost b-sm"
					style={{ color: "var(--danger)" }}
					onClick={() => setConfirmDelete(true)}
				>
					删除供应商
				</button>
				<span className="pd-status" style={error === undefined ? undefined : { color: "var(--danger)" }}>
					{error ?? status}
				</span>
				<button type="button" className="b b-line b-sm" disabled={!dirty || saving} onClick={reset}>
					取消
				</button>
				<button type="button" className="b b-solid b-sm" disabled={!dirty || saving} onClick={submit}>
					{saving ? "保存中…" : "保存"}
				</button>
			</div>

			<ModelDialog
				open={dialog !== undefined}
				model={dialog?.index === undefined ? undefined : models[dialog.index]}
				existingIds={models.filter((_, position) => position !== dialog?.index).map((model) => model.id)}
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

			<Dialog
				open={confirmDelete}
				onClose={() => setConfirmDelete(false)}
				title="删除供应商"
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setConfirmDelete(false)}>
							取消
						</button>
						<button type="button" className="b b-danger" onClick={remove}>
							删除
						</button>
					</>
				}
			>
				<p style={{ margin: 0 }}>删除后 providers.json 中的这项配置会移除，不能撤销。</p>
				<p style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
					<Trash2 className="ic ic-12" />
					{provider.name}
				</p>
			</Dialog>
		</>
	);
}
