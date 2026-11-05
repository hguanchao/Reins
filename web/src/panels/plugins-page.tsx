import { Blocks, Plus, Store } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button, Menu, toast } from "../components/ui/index.ts";
import { pluginKindLabel } from "../lib/format.ts";
import { desktopBridge } from "../platform.ts";
import type { PluginInfo } from "../protocol.ts";
import { PanelPage } from "../shell/panel-page.tsx";

/** 插件管理页：已安装清单、详情占位与市场占位。 */
export function PluginsPage({
	plugins,
	onClose,
}: {
	readonly plugins: readonly PluginInfo[];
	onClose(): void;
}): ReactElement {
	const [tab, setTab] = useState("installed");
	const [selected, setSelected] = useState<PluginInfo | undefined>(undefined);
	const [detailTab, setDetailTab] = useState("overview");
	const bridge = desktopBridge();

	const installPlugin = (): void => {
		if (bridge === undefined) return;
		void bridge
			.installPlugin()
			.then((result) => {
				if (!result.ok) {
					if (result.error !== "已取消") toast(result.error ?? "安装插件失败", "error");
					return;
				}
				toast(`插件 ${result.name ?? ""} 已安装，正在重启 Reins…`);
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			);
	};

	const togglePlugin = (plugin: PluginInfo): void => {
		if (bridge === undefined) return;
		void bridge
			.togglePlugin(plugin.name, !plugin.disabled)
			.then((result) => {
				if (!result.ok) {
					toast(result.error ?? "更新插件状态失败", "error");
					return;
				}
				toast(plugin.disabled ? "插件已启用，正在重启 Reins…" : "插件已禁用，正在重启 Reins…");
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			);
	};

	if (selected !== undefined) {
		return (
			<PanelPage
				title={selected.name}
				description={`插件类型：${pluginKindLabel(selected.kind)}`}
				onClose={onClose}
				tabs={[
					{ id: "overview", label: "概览" },
					{ id: "config", label: "配置" },
					{ id: "logs", label: "日志" },
				]}
				activeTab={detailTab}
				onTab={setDetailTab}
				actions={
					<Button
						variant="outline"
						size="sm"
						className="h-7 rounded-sm px-3 text-[12px]"
						onClick={() => setSelected(undefined)}
					>
						返回列表
					</Button>
				}
			>
				{detailTab === "overview" ? (
					<div className="flex flex-col gap-3">
						<div className="flex items-start gap-3 rounded-xl border-[0.5px] border-card-border bg-card p-4">
							<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
								<Blocks className="size-4" />
							</span>
							<div className="min-w-0 flex-1">
								<div className="text-[14px] leading-[22px] font-medium">{selected.name}</div>
								<div className="mt-1 flex items-center gap-1.5 text-[12px] leading-[18px] text-foreground-subtlest">
									<span
										className={
											selected.disabled
												? "size-1.5 rounded-full bg-foreground-subtlest"
												: "size-1.5 rounded-full bg-success"
										}
									/>
									{selected.disabled ? "已禁用" : "已启用"}
								</div>
							</div>
							<Button
								variant="outline"
								size="sm"
								className="h-7 rounded-sm px-3 text-[12px]"
								disabled={bridge === undefined}
								onClick={() => togglePlugin(selected)}
							>
								{selected.disabled ? "启用" : "停用"}
							</Button>
						</div>
						<PluginInfoRow label="标识" value={selected.name} />
						<PluginInfoRow label="类型" value={pluginKindLabel(selected.kind)} />
						<PluginInfoRow label="来源" value="Reins 进程内注册" />
						<p className="m-0 pt-2 text-[12px] leading-[18px] text-foreground-subtlest">
							配置表单与日志尚未接入；启停可在这里操作，卸载在扩展管理中。
						</p>
					</div>
				) : detailTab === "config" ? (
					<PlaceholderCard title="配置表单尚未接入" text="插件没有声明可视化配置项，当前只读取 Reins 装载状态。" />
				) : (
					<PlaceholderCard title="插件日志尚未接入" text="Reins 还没有把插件运行日志转发到界面。" />
				)}
			</PanelPage>
		);
	}

	return (
		<PanelPage
			title="插件"
			description="扩展 Reins 的工具、模型与界面能力。"
			onClose={onClose}
			tabs={[
				{ id: "installed", label: "已安装" },
				{ id: "market", label: "插件市场" },
			]}
			activeTab={tab}
			onTab={setTab}
			actions={
				<Menu
					align="end"
					trigger={({ toggle }) => (
						<Button variant="outline" size="sm" className="h-7 rounded-sm px-3 text-[12px]" onClick={toggle}>
							<Plus className="size-3.5" />
							添加插件
						</Button>
					)}
					entries={[
						{ type: "label", label: "安装来源" },
						{ type: "item", key: "market", label: "从插件市场安装", disabled: true, onSelect: () => {} },
						{
							type: "item",
							key: "local",
							label: bridge === undefined ? "从本地安装（桌面端可用）" : "从本地安装",
							disabled: bridge === undefined,
							onSelect: installPlugin,
						},
						{ type: "item", key: "author", label: "创建插件包", disabled: true, onSelect: () => {} },
					]}
				/>
			}
		>
			{tab === "installed" ? (
				plugins.length === 0 ? (
					<EmptyPlugins />
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
						{plugins.map((plugin) => (
							<button
								key={plugin.name}
								type="button"
								onClick={() => {
									setSelected(plugin);
									setDetailTab("overview");
								}}
								className="flex items-start gap-3 rounded-xl border-[0.5px] border-card-border bg-card p-3.5 text-left transition-colors hover:bg-surface-hover"
							>
								<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
									<Blocks className="size-4" />
								</span>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="min-w-0 truncate text-[14px] leading-[22px] font-medium">
											{plugin.name}
										</span>
										<span className="shrink-0 rounded-xs border-[0.5px] border-border px-1.5 text-[11px] leading-4 text-foreground-subtle">
											{pluginKindLabel(plugin.kind)}
										</span>
									</div>
									<div className="mt-1 flex items-center gap-1.5 text-[12px] leading-[18px] text-foreground-subtlest">
										<span
											className={
												plugin.disabled
													? "size-1.5 rounded-full bg-foreground-subtlest"
													: "size-1.5 rounded-full bg-success"
											}
										/>
										{plugin.disabled ? "已禁用" : "已启用"}
									</div>
								</div>
							</button>
						))}
					</div>
				)
			) : (
				<div className="flex flex-col items-center gap-3 py-24 text-center">
					<Store className="size-10 text-foreground-subtlest" />
					<div className="text-[14px] leading-[22px] font-medium">插件市场尚未接入</div>
					<p className="m-0 max-w-[380px] text-[13px] leading-5 text-foreground-subtlest">
						当前版本只展示已经装载的插件；桌面端可以从本地安装。市场检索、安装与版本更新需要 Reins 提供插件仓库支持。
					</p>
				</div>
			)}
		</PanelPage>
	);
}

function PluginInfoRow({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
	return (
		<div className="flex items-center justify-between gap-4 border-b-[0.5px] border-border py-3 text-[13px] leading-5">
			<span className="text-foreground-subtle">{label}</span>
			<span className="min-w-0 truncate text-right font-mono text-[12px]">{value}</span>
		</div>
	);
}

function PlaceholderCard({ title, text }: { readonly title: string; readonly text: string }): ReactElement {
	return (
		<div className="flex flex-col items-start gap-2 rounded-xl border-[0.5px] border-border bg-card px-4 py-5">
			<div className="text-[14px] leading-[22px] font-medium">{title}</div>
			<p className="m-0 max-w-[520px] text-[13px] leading-5 text-foreground-subtlest">{text}</p>
		</div>
	);
}

function EmptyPlugins(): ReactElement {
	return (
		<div className="flex flex-col items-center gap-3 py-24 text-center">
			<Blocks className="size-10 text-foreground-subtlest" />
			<div className="text-[14px] leading-[22px] font-medium">还没有装载插件</div>
			<p className="m-0 max-w-[360px] text-[13px] leading-5 text-foreground-subtlest">
				Reins 的核心能力全部内置；插件用于接入外部工具或替换已有手段。
			</p>
		</div>
	);
}
