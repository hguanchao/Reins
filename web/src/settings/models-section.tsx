import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import type { ProviderView, SettingsSnapshot, ThinkingLevel } from "../protocol.ts";
import { Section, SettingsPane } from "./controls.tsx";
import { ProviderDetail } from "./provider-detail.tsx";

/**
 * 模型。
 *
 * 主从两栏：左 178px 是用户自己起的供应商名字，右侧是连接与模型清单。不按提供方各开一页，
 * 换供应商是一等动作。Reins 不预置任何供应商，所有字段都可编辑。
 */
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

	const load = (): void => {
		void api
			.providers()
			.then((list) => {
				setProviders(list);
				setSelectedId((current) =>
					current !== undefined && list.some((provider) => provider.id === current) ? current : list[0]?.id,
				);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	};

	useEffect(() => {
		load();
	}, []);

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
		setProviders((list) => list?.map((item) => (item.id === provider.id ? { ...item, enabled } : item)));
		void api.setProviderEnabled(provider.id, enabled).catch((cause: unknown) => {
			setProviders((list) =>
				list?.map((item) => (item.id === provider.id ? { ...item, enabled: !enabled } : item)),
			);
			setError(cause instanceof Error ? cause.message : String(cause));
		});
	};

	return (
		<SettingsPane
			eyebrow="SETTINGS / MODELS"
			title="模型"
			description="Reins 不预置任何供应商；名称、地址、格式、密钥与模型都由你自己填写。"
		>
			<Section name="自定义供应商" hint={`${providers?.length ?? 0} 个`}>
				<div className="set-split">
					<div className="col-l">
						<div className="lbl">供应商</div>
						{providers?.map((provider) => (
							<button
								key={provider.id}
								type="button"
								className="prov"
								aria-current={provider.id === selectedId}
								onClick={() => setSelectedId(provider.id)}
							>
								<span className="mk">{provider.name.slice(0, 1).toUpperCase()}</span>
								<span className="nm">{provider.name}</span>
								<span
									className={`dot${!provider.enabled ? " off" : provider.hasApiKey ? "" : " hollow"}`}
									title={!provider.enabled ? "已停用" : provider.hasApiKey ? "已配置密钥" : "缺少密钥"}
								/>
							</button>
						))}
						<button type="button" className="prov-add" onClick={create} disabled={creating}>
							<svg
								className="ic-12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M5 12h14" />
								<path d="M12 5v14" />
							</svg>
							添加供应商
						</button>
					</div>

					<div className="pd">
						{selected === undefined ? (
							<div className="pd-blank">
								<div className="t">还没有供应商</div>
								<p>添加一家兼容网关或本地推理服务；名称与所有字段都能随时修改。</p>
								<button type="button" className="b b-solid b-sm" onClick={create} disabled={creating}>
									添加供应商
								</button>
							</div>
						) : (
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
										: (settings.models.find((model) => model.model === settings.model)?.thinkingLevels ?? [])
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
				<p className="set-note">
					Reins 不预置任何供应商：名称、Base URL、API 格式、密钥与模型都由你填写，改名不影响历史任务。密钥只写进本机{" "}
					<span style={{ fontFamily: "var(--mono)" }}>providers.json</span>，界面默认遮蔽，点小眼睛可临时显示明文。
				</p>
				{error === undefined ? null : (
					<p className="set-note" style={{ color: "var(--danger)" }}>
						{error}
					</p>
				)}
			</Section>
		</SettingsPane>
	);
}
