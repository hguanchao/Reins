import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import type { ProviderView, SettingsSnapshot, ThinkingLevel } from "../protocol.ts";
import { ProviderDetail } from "./provider-detail.tsx";

/** 模型设置：左侧提供方导航，右侧该提供方的配置与模型列表。 */
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
	const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const load = useCallback((): void => {
		void api
			.providers()
			.then((list) => {
				setProviders(list);
				setSelectedId((current) =>
					current !== undefined && list.some((provider) => provider.id === current)
						? current
						: list[0]?.id,
				);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const selected = providers?.find((provider) => provider.id === selectedId);

	/** 直接在右栏建一张空白表单，写盘后再补齐模型 */
	const create = (): void => {
		if (creating) return;
		setCreating(true);
		const id = `custom-${Date.now().toString(36)}`;
		void api
			.saveProvider({ id, name: "新供应商", api: "anthropic-messages", baseUrl: "", models: [] })
			.then(() => {
				setSelectedId(id);
				load();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setCreating(false));
	};

	const toggle = (provider: ProviderView, enabled: boolean): void => {
		// 先落界面再发请求，失败按原值回滚
		setProviders((list) =>
			list?.map((item) => (item.id === provider.id ? { ...item, enabled } : item)),
		);
		void api.setProviderEnabled(provider.id, enabled).catch((cause: unknown) => {
			setProviders((list) =>
				list?.map((item) => (item.id === provider.id ? { ...item, enabled: !enabled } : item)),
			);
			setError(cause instanceof Error ? cause.message : String(cause));
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<h1 className="m-0 text-[27px] leading-9 font-bold tracking-[-0.02em]">模型设置</h1>
					<p className="mt-1.5 mb-0 max-w-[560px] text-[12.5px] leading-[19px] text-foreground-subtle">
						管理自定义模型供应商，配置后可在聊天时选择使用。
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2 pt-1">
					<button
						type="button"
						aria-label="刷新"
						title="刷新"
						onClick={load}
						className="flex size-7 items-center justify-center rounded-md border-[0.5px] border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
					>
						<RefreshCw className="size-3.5" />
					</button>
					<Button variant="primary" size="sm" disabled={creating} onClick={create}>
						<Plus className="size-3.5" />
						添加供应商
					</Button>
				</div>
			</div>

			{providers === undefined ? (
				<div className="rounded-xl border-[0.5px] border-border px-4 py-10 text-center text-[12px] leading-[18px] text-foreground-subtlest">
					正在读取提供方…
				</div>
			) : providers.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border-[0.5px] border-dashed border-border px-6 py-16 text-center">
					<span className="text-[13px] leading-5">还没有配置提供方</span>
					<Button variant="outline" size="sm" disabled={creating} onClick={create}>
						<Plus className="size-3.5" />
						添加供应商
					</Button>
				</div>
			) : (
				<div className="grid min-h-[480px] grid-cols-[180px_minmax(0,1fr)] overflow-hidden rounded-xl border-[0.5px] border-border">
					<nav aria-label="提供方" className="min-w-0 border-r-[0.5px] border-border">
						<div className="px-3 pt-3 pb-1 text-[11px] leading-4 text-foreground-subtlest">
							提供方
						</div>
						<div className="flex flex-col gap-0.5 px-1.5 pb-3">
							{providers.map((provider) => {
								const active = provider.id === selectedId;
								return (
									<button
										key={provider.id}
										type="button"
										aria-current={active ? "true" : undefined}
										onClick={() => setSelectedId(provider.id)}
										className={cn(
											"flex h-[30px] items-center gap-2 rounded-md border-[0.5px] px-2 text-left text-[12.5px] leading-[18px] transition-colors",
											active
												? "border-border bg-card-selected"
												: "border-transparent hover:bg-surface-hover",
										)}
									>
										<span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface text-[9px] leading-none font-semibold text-foreground-subtle">
											{provider.name.slice(0, 1)}
										</span>
										<span className="min-w-0 flex-1 truncate">{provider.name}</span>
										<span
											className={cn(
												"size-1.5 shrink-0 rounded-full",
												!provider.enabled
													? "bg-border"
													: provider.hasApiKey
														? "bg-success"
														: "bg-warning",
											)}
										/>
									</button>
								);
							})}
						</div>
					</nav>

					<div className="min-w-0 overflow-y-auto p-4">
						{selected === undefined ? null : (
							<ProviderDetail
								key={selected.id}
								provider={selected}
								current={
									settings === undefined
										? undefined
										: { provider: settings.provider, model: settings.model }
								}
								effort={settings?.effort ?? "off"}
								levels={
									settings === undefined || settings.provider !== selected.id
										? []
										: (settings.models.find((model) => model.model === settings.model)
												?.thinkingLevels ?? [])
								}
								onSelectModel={onModel}
								onUpdate={onUpdate}
								onToggleEnabled={(enabled) => toggle(selected, enabled)}
								onSaved={() => {
									load();
									onRefresh();
								}}
								onDeleted={() => {
									load();
									onRefresh();
								}}
							/>
						)}
					</div>
				</div>
			)}

			{error === undefined ? null : (
				<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
			)}
		</div>
	);
}
