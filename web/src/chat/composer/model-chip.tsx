import { Check, ChevronDown, ChevronLeft } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { cn } from "../../components/ui/cn.ts";
import { Popover } from "../../components/ui/popover.tsx";
import type { ModelInfo, SettingsModel, ThinkingLevel } from "../../protocol.ts";
import { EFFORT_LABELS } from "./model.ts";

/** 模型 · 思考合并选择器：一级提供商、二级模型与思考强度。 */
export function ModelChip({
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
			// 停用的模型不出现在选择器里；当前正在用的那一个保留，否则这一栏会看不出自己在哪
			if (item.disabled && item.model !== model.model) continue;
			const entry = map.get(item.provider) ?? { id: item.provider, name: item.providerName, models: [] };
			entry.models.push(item);
			map.set(item.provider, entry);
		}
		return [...map.values()];
	}, [models, model.model]);

	const inProvider = providers.find((entry) => entry.models.some((item) => item.model === model.model));
	const effortIndex = Math.max(0, levels.indexOf(effort));
	const entry = providers.find((item) => item.id === providerId);

	return (
		<Popover
			placement="above"
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
							<span className="dot">·</span>
							<span>思考 {EFFORT_LABELS[effort]}</span>
						</>
					)}
					<ChevronDown className="ic ic-12" />
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
									<Check className="ic ic-12 pv-check" />
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
								<ChevronLeft className="ic ic-12" />
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
								{item.model === model.model ? <Check className="ic ic-12 ck" /> : null}
							</button>
						))}
						{levels.length <= 1 ? null : (
							<>
								<div className="es-head">
									<span className="l">思考强度</span>
									<span className="v">{EFFORT_LABELS[effort]}</span>
									<span className="k">Ctrl 1</span>
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
									{/* 轨道微粒照设计稿摆位：五颗，高低错落，只做质感不做刻度 */}
									<i className="pt" style={{ left: "18%", top: "32%" }} />
									<i className="pt" style={{ left: "40%", top: "64%" }} />
									<i className="pt" style={{ left: "58%", top: "26%" }} />
									<i className="pt" style={{ left: "76%", top: "60%" }} />
									<i className="pt" style={{ left: "90%", top: "30%" }} />
									<span className="es-thumb" style={{ left: `${8 + (effortIndex / Math.max(1, levels.length - 1)) * 84}%` }} />
								</div>
							</>
						)}
					</div>
				)
			}
		</Popover>
	);
}
