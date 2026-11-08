import { useState } from "react";
import type { ReactElement } from "react";

import { Dialog } from "../components/ui/index.ts";
import type { ProviderModel } from "../protocol.ts";

/** 单个模型的编辑弹层；新增时用提供方的协议与地址兜底。 */
export function ModelDialog({
	open,
	model,
	existingIds,
	patch,
	onSubmit,
	onClose,
}: {
	readonly open: boolean;
	/** undefined 表示新增 */
	readonly model: ProviderModel | undefined;
	readonly existingIds: readonly string[];
	readonly patch: { readonly api: string; readonly baseUrl: string };
	onSubmit(next: ProviderModel): void;
	onClose(): void;
}): ReactElement {
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [contextWindow, setContextWindow] = useState("");
	const [maxTokens, setMaxTokens] = useState("");
	const [reasoning, setReasoning] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	// 每次打开重置一次，避免沿用上一次的输入
	const [seed, setSeed] = useState<string | undefined>(undefined);
	const key = `${open ? "1" : "0"}:${model?.id ?? ""}`;
	if (seed !== key) {
		setSeed(key);
		if (open) {
			setId(model?.id ?? "");
			setName(model?.name ?? "");
			setContextWindow(model?.contextWindow === undefined ? "" : String(model.contextWindow));
			setMaxTokens(model?.maxTokens === undefined ? "" : String(model.maxTokens));
			setReasoning(model?.reasoning ?? false);
			setError(undefined);
		}
	}

	const submit = (): void => {
		const trimmedId = id.trim();
		if (trimmedId.length === 0) {
			setError("请填写模型 ID");
			return;
		}
		if (existingIds.includes(trimmedId)) {
			setError("模型 ID 重复");
			return;
		}
		onSubmit({
			id: trimmedId,
			name: name.trim().length === 0 ? trimmedId : name.trim(),
			api: model?.api ?? patch.api,
			baseUrl: model?.baseUrl ?? patch.baseUrl,
			reasoning,
			thinkingLevelMap: model?.thinkingLevelMap ?? {},
			input: model?.input ?? ["text"],
			cost: model?.cost,
			contextWindow: positive(contextWindow),
			maxTokens: positive(maxTokens),
			maxTokensField: model?.maxTokensField ?? "max_tokens",
			headers: model?.headers ?? {},
		});
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title={model === undefined ? "添加模型" : "编辑模型"}
			footer={
				<>
					<button type="button" className="b b-line" onClick={onClose}>
						取消
					</button>
					<button type="button" className="b b-solid" onClick={submit}>
						确定
					</button>
				</>
			}
		>
			<label>
				<span className="form-label">模型 ID</span>
				<input
					value={id}
					onChange={(event) => setId(event.target.value)}
					placeholder="如 claude-sonnet-4-6"
					aria-label="模型 ID"
					autoFocus
					className="form-input"
				/>
			</label>
			<label>
				<span className="form-label">显示名称</span>
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="留空时用模型 ID"
					aria-label="模型名称"
					className="form-input"
				/>
			</label>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
				<label>
					<span className="form-label">上下文窗口</span>
					<input
						value={contextWindow}
						onChange={(event) => setContextWindow(event.target.value)}
						inputMode="numeric"
						placeholder="200000"
						aria-label="上下文窗口"
						className="form-input"
					/>
				</label>
				<label>
					<span className="form-label">最大输出</span>
					<input
						value={maxTokens}
						onChange={(event) => setMaxTokens(event.target.value)}
						inputMode="numeric"
						placeholder="可选"
						aria-label="最大输出"
						className="form-input"
					/>
				</label>
			</div>
			<label style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<input
					type="checkbox"
					checked={reasoning}
					onChange={(event) => setReasoning(event.target.checked)}
					style={{ width: 15, height: 15, accentColor: "var(--ink)" }}
				/>
				<span>支持思考等级</span>
			</label>
			{error === undefined ? null : <p className="form-error">{error}</p>}
		</Dialog>
	);
}

function positive(value: string): number | undefined {
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
