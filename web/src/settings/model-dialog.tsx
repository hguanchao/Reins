import { Check, ChevronDown } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Dialog, Popover } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import type { ProviderModel, ThinkingLevel } from "../protocol.ts";
import { parseModelSize } from "./settings-model.ts";

/** 数量输入框只收纯数字，编辑时按原始数字回填。 */
function sizeText(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

/** 输入时直接滤掉非数字字符，避免把 1m、128k 这类短写法带进提交。 */
function digitsOnly(value: string): string {
	return value.replace(/\D/g, "");
}

/** 关闭之外的思考等级，顺序与内核的等级阶梯一致。 */
const LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

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
	const [contextWindow, setContextWindow] = useState("");
	const [maxTokens, setMaxTokens] = useState("");
	const [levels, setLevels] = useState<readonly ThinkingLevel[]>([]);
	const [imageInput, setImageInput] = useState(false);
	const [maxTokensField, setMaxTokensField] = useState<ProviderModel["maxTokensField"]>("max_tokens");
	// 高级配置默认展开：输入形态与推理等级是常改项，折叠起来反而多一次点击
	const [advOpen, setAdvOpen] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);
	// 每次打开重置一次，避免沿用上一次的输入
	const [seed, setSeed] = useState<string | undefined>(undefined);
	const key = `${open ? "1" : "0"}:${model?.id ?? ""}`;
	if (seed !== key) {
		setSeed(key);
		if (open) {
			setId(model?.id ?? "");
			setContextWindow(sizeText(model?.contextWindow));
			setMaxTokens(sizeText(model?.maxTokens));
			setLevels(enabledLevels(model));
			setImageInput((model?.input ?? ["text"]).includes("image"));
			setMaxTokensField(model?.maxTokensField ?? "max_tokens");
			setAdvOpen(true);
			setError(undefined);
		}
	}

	const reset = (): void => {
		setId(model?.id ?? "");
		setContextWindow(sizeText(model?.contextWindow));
		setMaxTokens(sizeText(model?.maxTokens));
		setLevels(enabledLevels(model));
		setImageInput((model?.input ?? ["text"]).includes("image"));
		setMaxTokensField(model?.maxTokensField ?? "max_tokens");
		setError(undefined);
	};

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
		const context = parseModelSize(contextWindow);
		if (contextWindow.trim().length > 0 && context === undefined) {
			setError("上下文窗口只能填正整数");
			return;
		}
		const output = parseModelSize(maxTokens);
		if (maxTokens.trim().length > 0 && output === undefined) {
			setError("最大输出只能填正整数");
			return;
		}
		onSubmit({
			id: trimmedId,
			// 界面不再单独起「显示名称」：编辑时沿用原名，新建时用 ID
			name: model?.name ?? trimmedId,
			api: model?.api ?? patch.api,
			baseUrl: model?.baseUrl ?? patch.baseUrl,
			disabled: model?.disabled ?? false,
			reasoning: levels.length > 0,
			thinkingLevelMap: levelMap(model, levels),
			input: imageInput ? ["text", "image"] : ["text"],
			cost: model?.cost,
			contextWindow: context,
			maxTokens: output,
			maxTokensField,
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
					<button type="button" className="b b-ghost b-sm" onClick={reset}>
						重置表单
					</button>
					<span className="flex-1" />
					<button type="button" className="b b-line b-sm" onClick={onClose}>
						取消
					</button>
					<button type="button" className="b b-solid b-sm" onClick={submit}>
						保存
					</button>
				</>
			}
		>
			<div className="mm-field">
				<span className="form-label">模型 ID</span>
				<input
					value={id}
					onChange={(event) => {
						setId(event.target.value);
						setError(undefined);
					}}
					placeholder="如 claude-sonnet-4-6"
					aria-label="模型 ID"
					autoFocus
					spellCheck={false}
					autoComplete="off"
					className="form-input"
				/>
				{error === undefined ? null : <p className="form-error">{error}</p>}
			</div>
			<div className="mm-field">
				<span className="form-label">上下文窗口</span>
				<input
					value={contextWindow}
					onChange={(event) => setContextWindow(digitsOnly(event.target.value))}
					placeholder="如 128000"
					aria-label="上下文窗口"
					inputMode="numeric"
					spellCheck={false}
					autoComplete="off"
					className="form-input"
				/>
			</div>
			<div className="mm-field">
				<span className="form-label">最大输出 Token</span>
				<input
					value={maxTokens}
					onChange={(event) => setMaxTokens(digitsOnly(event.target.value))}
					placeholder="如 8192"
					aria-label="最大输出"
					inputMode="numeric"
					spellCheck={false}
					autoComplete="off"
					className="form-input"
				/>
			</div>

			<button
				type="button"
				className="mm-adv-h"
				aria-expanded={advOpen}
				onClick={() => setAdvOpen((value) => !value)}
			>
				<ChevronDown className="ic ic-12 chev" />
				高级配置
			</button>

			{advOpen ? (
				<div className="mm-grid">
					<PickSelect
						label="输入类型"
						multiple
						value={imageInput ? ["text", "image"] : ["text"]}
						options={[
							{ value: "text", label: "文本", locked: true },
							{ value: "image", label: "图片" },
						]}
						onChange={(next) => setImageInput(next.includes("image"))}
					/>
					<PickSelect
						label="输出上限字段"
						value={[maxTokensField]}
						options={[
							{ value: "max_tokens", label: "max_tokens" },
							{ value: "max_completion_tokens", label: "max_completion_tokens" },
						]}
						onChange={(next) =>
							setMaxTokensField(next[0] === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens")
						}
					/>
					<PickSelect
						label="推理等级"
						multiple
						summary={
							levels.length === 0
								? LEVEL_LABELS.off
								: levels.length === LEVELS.length
									? "全部等级"
									: levels.map((level) => LEVEL_LABELS[level]).join("、")
						}
						value={levels.length === 0 ? ["off"] : [...levels]}
						options={[
							{ value: "off", label: LEVEL_LABELS.off },
							...LEVELS.map((level) => ({ value: level, label: LEVEL_LABELS[level] })),
						]}
						onChange={(next) => setLevels(LEVELS.filter((level) => next.includes(level)))}
					/>
				</div>
			) : null}
		</Dialog>
	);
}

/** 高级配置里的下拉：单选与多选共用一套外观，勾选标记表示当前取值。 */
function PickSelect({
	label,
	value,
	options,
	multiple = false,
	summary,
	onChange,
}: {
	readonly label: string;
	readonly value: readonly string[];
	readonly options: readonly { readonly value: string; readonly label: string; readonly locked?: boolean }[];
	readonly multiple?: boolean;
	/** 选项多时由调用方给一句概括，避免下拉框里显示一长串被截断 */
	readonly summary?: string;
	onChange(next: readonly string[]): void;
}): ReactElement {
	const picked =
		summary ??
		(options
			.filter((option) => value.includes(option.value))
			.map((option) => option.label)
			.join("、") ||
			"未选择");

	return (
		<div className="mm-field">
			<span className="form-label">{label}</span>
			<Popover
				align="start"
				zIndex={420}
				trigger={({ open, toggle }) => (
					<button
						type="button"
						className="mm-select"
						aria-expanded={open}
						aria-haspopup="listbox"
						aria-label={label}
						onClick={toggle}
					>
						<span className="val">{picked}</span>
						<ChevronDown className="ic ic-12 chev" />
					</button>
				)}
			>
				{(close) =>
					options.map((option) => {
						const checked = value.includes(option.value);
						return (
							<button
								key={option.value}
								type="button"
								role="option"
								aria-selected={checked}
								disabled={option.locked === true}
								className={cn("pop-i", checked && "sel")}
								onClick={() => {
									if (option.locked === true) return;
									if (!multiple) {
										onChange([option.value]);
										close();
										return;
									}
									onChange(
										checked
											? value.filter((item) => item !== option.value)
											: [...value, option.value],
									);
								}}
							>
								<span className="min-w-0 flex-1 truncate">{option.label}</span>
								{checked ? <Check className="ic ic-12 ck" /> : null}
							</button>
						);
					})
				}
			</Popover>
		</div>
	);
}

/** 已启用的等级：没支持的看 thinkingLevelMap 里显式为 null 的项。 */
function enabledLevels(model: ProviderModel | undefined): readonly ThinkingLevel[] {
	if (model?.reasoning !== true) return [];
	return LEVELS.filter((level) => model.thinkingLevelMap[level] !== null);
}

/** 勾掉的等级写成 null（不支持），重新勾上的恢复成 provider 默认取值。 */
function levelMap(
	model: ProviderModel | undefined,
	levels: readonly ThinkingLevel[],
): ProviderModel["thinkingLevelMap"] {
	const map: ProviderModel["thinkingLevelMap"] = { ...(model?.thinkingLevelMap ?? {}) };
	for (const level of LEVELS) {
		if (levels.includes(level)) {
			if (map[level] === null) delete map[level];
			continue;
		}
		map[level] = null;
	}
	return map;
}
