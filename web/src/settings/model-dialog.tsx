import { useState } from "react";
import type { ReactElement } from "react";

import { Button, Dialog } from "../components/ui/index.ts";
import type { ProviderModel } from "../protocol.ts";

const FIELD =
	"h-8 w-full rounded-md border-[0.5px] border-input-border bg-input px-2.5 text-[12px] leading-[18px] outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";

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
					<Button variant="outline" size="sm" onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" onClick={submit}>
						确定
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">模型 ID</span>
					<input
						value={id}
						onChange={(event) => setId(event.target.value)}
						placeholder="如 claude-sonnet-4-6"
						aria-label="模型 ID"
						autoFocus
						className={FIELD}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">显示名称</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="留空时用模型 ID"
						aria-label="模型名称"
						className={FIELD}
					/>
				</label>
				<div className="grid grid-cols-2 gap-3">
					<label className="flex flex-col gap-1">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">上下文窗口</span>
						<input
							value={contextWindow}
							onChange={(event) => setContextWindow(event.target.value)}
							inputMode="numeric"
							placeholder="200000"
							aria-label="上下文窗口"
							className={FIELD}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">最大输出</span>
						<input
							value={maxTokens}
							onChange={(event) => setMaxTokens(event.target.value)}
							inputMode="numeric"
							placeholder="可选"
							aria-label="最大输出"
							className={FIELD}
						/>
					</label>
				</div>
				<label className="flex items-center gap-2 text-[12px] leading-[18px] text-foreground-subtle">
					<input
						type="checkbox"
						checked={reasoning}
						onChange={(event) => setReasoning(event.target.checked)}
						className="size-3.5 accent-(--accent)"
					/>
					支持思考等级
				</label>
				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}

function positive(value: string): number | undefined {
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
