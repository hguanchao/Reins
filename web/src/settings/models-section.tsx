import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import { formatTokens } from "../lib/format.ts";
import type { ProviderView, SettingsModel, SettingsSnapshot, ThinkingLevel } from "../protocol.ts";
import { Badge, ChoiceGroup, SettingRow, SettingsCard, SettingsHeader } from "./controls.tsx";
import { ProviderDialog } from "./provider-dialog.tsx";

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

/** 模型设置：模型来自本机 providers.json，切换后写回当前配置。 */
export function ModelsSection({
	settings,
	onModel,
	onUpdate,
	onRefresh,
}: {
	readonly settings: SettingsSnapshot | undefined;
	onModel(provider: string, model: string): void;
	onUpdate(update: { effort?: ThinkingLevel }): void;
	onRefresh(): void;
}): ReactElement {
	const [providers, setProviders] = useState<readonly ProviderView[] | undefined>(undefined);
	const [dialog, setDialog] = useState<
		{ readonly mode: "new" } | { readonly mode: "edit"; readonly provider: ProviderView } | undefined
	>(undefined);
	const [deleteTarget, setDeleteTarget] = useState<ProviderView | undefined>(undefined);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const loadProviders = useCallback((): void => {
		void api
			.providers()
			.then(setProviders)
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, []);

	useEffect(() => {
		loadProviders();
	}, [loadProviders]);

	const removeProvider = (): void => {
		if (deleteTarget === undefined || deleting) return;
		setDeleting(true);
		setError(undefined);
		void api
			.deleteProvider(deleteTarget.id)
			.then(() => {
				toast("提供方已删除");
				setDeleteTarget(undefined);
				loadProviders();
				onRefresh();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setDeleting(false));
	};

	if (settings === undefined) {
		return (
			<div className="flex flex-col gap-7">
				<SettingsHeader title="模型设置" description="正在读取本机配置…" />
			</div>
		);
	}

	const groups = new Map<string, SettingsModel[]>();
	for (const model of settings.models) {
		const list = groups.get(model.providerName) ?? [];
		list.push(model);
		groups.set(model.providerName, list);
	}
	const current = settings.models.find(
		(model) => model.provider === settings.provider && model.model === settings.model,
	);
	const levels = current?.thinkingLevels ?? (["off"] as const);

	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader
				title="模型设置"
				description="模型来自本机 providers.json；切换后会写回当前配置，并在空闲时生效。"
			/>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">提供方与模型</h2>
				{groups.size === 0 ? (
					<div className="rounded-[16px] border-[0.5px] border-border bg-card px-4 py-6 text-[13px] leading-5 text-foreground-subtlest">
						没有发现可用模型。请先在 providers.json 中配置提供方。
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{[...groups.entries()].map(([providerName, models]) => (
							<SettingsCard key={providerName}>
								<div className="flex items-center gap-2 border-b-[0.5px] border-border px-4 py-3">
									<span className="size-1.5 rounded-full bg-success" />
									<span className="text-[13px] leading-5 font-medium">{providerName}</span>
									<Badge tone="success">已配置</Badge>
									<span className="ml-auto text-[11px] leading-4 text-foreground-subtlest">
										{models.length} 个模型
									</span>
								</div>
								<div className="flex flex-col p-1.5">
									{models.map((model) => {
										const active =
											model.provider === settings.provider && model.model === settings.model;
										return (
											<button
												key={`${model.provider}/${model.model}`}
												type="button"
												onClick={() => onModel(model.provider, model.model)}
												aria-pressed={active}
												className={cn(
													"flex min-h-10 items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors",
													active ? "bg-surface" : "hover:bg-surface-hover",
												)}
											>
												<span
													className={cn(
														"flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]",
														active ? "border-(--accent)" : "border-border",
													)}
												>
													{active ? (
														<Check className="size-2.5 text-(--accent)" strokeWidth={3} />
													) : null}
												</span>
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[13px] leading-5">{model.name}</span>
													<span className="block truncate font-mono text-[11px] leading-4 text-foreground-subtlest">
														{model.model}
													</span>
												</span>
												{model.reasoning ? <Badge tone="muted">思考</Badge> : null}
												<span className="shrink-0 font-mono text-[11px] leading-4 text-foreground-subtlest">
													{model.contextWindow === undefined ? "—" : formatTokens(model.contextWindow)}
												</span>
											</button>
										);
									})}
								</div>
							</SettingsCard>
						))}
					</div>
				)}
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">思考等级</h2>
				<SettingsCard>
					<SettingRow title="当前模型支持的等级" description="关闭表示不向模型发送思考参数。">
						<ChoiceGroup
							options={levels.map((level) => ({ key: level, label: EFFORT_LABELS[level] }))}
							selected={settings.effort}
							onSelect={(effort) => onUpdate({ effort })}
						/>
					</SettingRow>
				</SettingsCard>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">当前选择</h2>
				<SettingsCard>
					<SettingRow title="当前模型" description="本轮任务使用的提供方与模型标识。">
						<span className="font-mono text-[12px] leading-[18px] text-foreground-subtle">
							{settings.provider} / {settings.model}
						</span>
					</SettingRow>
					<SettingRow title="压缩模型" description="上下文压缩时单独使用的模型。">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">
							{settings.compactModel ?? "未单独配置"}
						</span>
					</SettingRow>
					<SettingRow title="审查模型" description="自动审批时判断风险的模型。">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">
							{settings.reviewModel ?? "未单独配置"}
						</span>
					</SettingRow>
					<SettingRow title="提供方配置" description="用户级 providers.json 的位置。">
						<span className="max-w-[360px] break-all text-right font-mono text-[11px] leading-4 text-foreground-subtle">
							{settings.providersPath}
						</span>
					</SettingRow>
				</SettingsCard>
			</section>

			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2 px-1">
					<h2 className="m-0 text-[13px] leading-5 font-medium">提供方</h2>
					<Button
						variant="outline"
						size="sm"
						className="h-7 rounded-md px-2.5 text-[12px]"
						onClick={() => setDialog({ mode: "new" })}
					>
						<Plus className="size-3.5" />
						添加提供方
					</Button>
				</div>
				<SettingsCard>
					{providers === undefined ? (
						<div className="px-4 py-4 text-[12px] leading-[18px] text-foreground-subtlest">
							正在读取提供方…
						</div>
					) : providers.length === 0 ? (
						<div className="px-4 py-4 text-[12px] leading-[18px] text-foreground-subtlest">
							还没有提供方，先添加一个。
						</div>
					) : (
						providers.map((provider, index) => (
							<div
								key={provider.id}
								className={
									index === providers.length - 1
										? "flex flex-wrap items-center gap-3 px-4 py-3"
										: "flex flex-wrap items-center gap-3 border-b-[0.5px] border-border px-4 py-3"
								}
							>
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-2">
										<span className="truncate text-[13px] leading-5 font-medium">{provider.name}</span>
										<Badge>{provider.id}</Badge>
									</div>
									<div className="text-[11px] leading-4 text-foreground-subtlest">
										{provider.models.length} 个模型 ·{" "}
										{provider.hasApiKey ? "API Key 已保存" : "未配置 API Key"}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<Button
										variant="outline"
										size="sm"
										className="h-7 rounded-md px-2.5 text-[12px]"
										onClick={() => setDialog({ mode: "edit", provider })}
									>
										编辑
									</Button>
									<button
										type="button"
										disabled={provider.id === settings.provider}
										title={provider.id === settings.provider ? "当前正在使用，不能删除" : "删除提供方"}
										onClick={() => {
											setError(undefined);
											setDeleteTarget(provider);
										}}
										className="flex h-7 items-center rounded-md px-2.5 text-[12px] leading-[18px] text-destructive transition-colors hover:bg-destructive-surface disabled:pointer-events-none disabled:opacity-40"
									>
										删除
									</button>
								</div>
							</div>
						))
					)}
				</SettingsCard>
				{error === undefined ? null : (
					<p className="m-0 px-1 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</section>

			<ProviderDialog
				open={dialog !== undefined}
				provider={dialog?.mode === "edit" ? dialog.provider : undefined}
				onClose={() => setDialog(undefined)}
				onSaved={() => {
					loadProviders();
					onRefresh();
				}}
			/>

			<Dialog
				open={deleteTarget !== undefined}
				onClose={() => {
					setDeleteTarget(undefined);
					setError(undefined);
				}}
				title="删除提供方"
				footer={
					<>
						<Button
							variant="outline"
							size="sm"
							disabled={deleting}
							onClick={() => {
								setDeleteTarget(undefined);
								setError(undefined);
							}}
						>
							取消
						</Button>
						<Button variant="danger" size="sm" disabled={deleting} onClick={removeProvider}>
							{deleting ? "删除中…" : "删除"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">
						删除后 providers.json 中的这项配置会移除，不能撤销。当前正在使用的提供方不能删除。
					</p>
					<p className="m-0 text-foreground">
						{deleteTarget?.name}
						<span className="ml-2 font-mono text-[12px] text-foreground-subtlest">
							{deleteTarget?.id}
						</span>
					</p>
					{error === undefined ? null : <p className="m-0 text-destructive">{error}</p>}
				</div>
			</Dialog>
		</div>
	);
}
