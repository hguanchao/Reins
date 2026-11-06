import {
	Blocks,
	Check,
	Minus,
	MoreHorizontal,
	PackagePlus,
	Pencil,
	Plus,
	Puzzle,
	RefreshCw,
	ScrollText,
	Search,
	Server,
	Store,
	Trash2,
	Upload,
	WandSparkles,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { StateDot, type StateDotState } from "../components/state-dot.tsx";
import { Button, Dialog, Menu, Switch, toast, type MenuEntry } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import { desktopBridge } from "../platform.ts";
import type { McpServerInput, SettingsSnapshot } from "../protocol.ts";
import { Badge, EmptyState, SettingsCard, SettingsHeader } from "./controls.tsx";
import { McpServerDialog } from "./mcp-server-dialog.tsx";
import { PluginLogsDialog } from "./plugin-logs-dialog.tsx";
import { SkillDialog } from "./skill-dialog.tsx";
import { SkillUploadDialog } from "./skill-upload-dialog.tsx";
import {
	countExtensions,
	extensionItems,
	filterExtensions,
	type ExtensionItem,
	type ExtensionKind,
} from "./settings-model.ts";

type Tab = "all" | ExtensionKind;

const TAB_LABELS: Record<Tab, string> = {
	all: "全部",
	plugin: "插件",
	skill: "技能",
	mcp: "MCP",
};

const KIND_LABELS: Record<ExtensionKind, string> = {
	plugin: "插件",
	skill: "技能",
	mcp: "MCP 服务器",
};

const KIND_ICONS: Record<ExtensionKind, LucideIcon> = {
	plugin: Puzzle,
	skill: WandSparkles,
	mcp: Server,
};

interface McpStatusView {
	readonly state: StateDotState;
	readonly label: string;
	readonly detail: string;
}

/** 运行期状态映射成界面上的点与一句话；未知状态按未连接处理。 */
function mcpStatusOf(item: ExtensionItem): McpStatusView | undefined {
	if (item.kind !== "mcp") return undefined;
	switch (item.status) {
		case "connected":
			return { state: "done", label: "已连接", detail: item.detail ?? "" };
		case "connecting":
			return { state: "ongoing", label: "连接中", detail: item.detail ?? "" };
		case "unreachable":
			return { state: "error", label: "连接失败", detail: item.detail ?? "" };
		case "disabled":
			return { state: "idle", label: "已禁用", detail: item.detail ?? "" };
		default:
			return { state: "idle", label: "未连接", detail: item.detail ?? "" };
	}
}

/** 各分类没有内容时的空态；与「搜索无结果」分开，避免把空分类说成没搜到。 */
const TAB_EMPTY: Record<Tab, { readonly icon: LucideIcon; readonly title: string; readonly description: string }> = {
	all: {
		icon: Blocks,
		title: "还没有装载扩展",
		description: "Reins 的核心能力全部内置；插件、技能与 MCP 服务器装载后会出现在这里。",
	},
	plugin: {
		icon: Puzzle,
		title: "还没有装载插件",
		description: "插件市场尚未接入；桌面端可以安装本地插件，已装载的插件会出现在这里。",
	},
	skill: {
		icon: WandSparkles,
		title: "还没有技能",
		description: "用「+」上传技能压缩包（.zip），技能会从下一回合开始可用。",
	},
	mcp: {
		icon: Server,
		title: "还没有 MCP 服务器",
		description: "用「+」添加 stdio、http 或 sse 服务器，连接成功后工具会在下一回合可用。",
	},
};

/** 扩展管理：插件、技能与 MCP 都来自宿主快照，这里只做清单、搜索与刷新。 */
export function ExtensionsSection({
	settings,
	onRefresh,
}: {
	readonly settings: SettingsSnapshot | undefined;
	onRefresh(): void;
}): ReactElement {
	const [tab, setTab] = useState<Tab>("all");
	const [query, setQuery] = useState("");
	const [infoOpen, setInfoOpen] = useState(false);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [mcpOpen, setMcpOpen] = useState(false);
	const [mcpEditTarget, setMcpEditTarget] = useState<McpServerInput | undefined>(undefined);
	const [mcpDeleteTarget, setMcpDeleteTarget] = useState<ExtensionItem | undefined>(undefined);
	const [mcpDeleting, setMcpDeleting] = useState(false);
	const [skillEditTarget, setSkillEditTarget] = useState<ExtensionItem | undefined>(undefined);
	const [skillDeleteTarget, setSkillDeleteTarget] = useState<ExtensionItem | undefined>(undefined);
	const [skillDeleting, setSkillDeleting] = useState(false);
	const [pluginRemoveTarget, setPluginRemoveTarget] = useState<ExtensionItem | undefined>(undefined);
	const [pluginLogsTarget, setPluginLogsTarget] = useState<ExtensionItem | undefined>(undefined);
	const bridge = desktopBridge();

	// MCP 状态会从 connecting 走到 connected/unreachable；页签打开时轮询，离开就停
	useEffect(() => {
		if (tab !== "mcp") return;
		const timer = window.setInterval(onRefresh, 3000);
		return () => window.clearInterval(timer);
	}, [tab, onRefresh]);

	const items = extensionItems(settings);
	const counts = countExtensions(items);
	const searching = query.trim().length > 0;
	const filtered = filterExtensions(
		items.filter((item) => tab === "all" || item.kind === tab),
		query,
	);
	const groups = (Object.keys(KIND_LABELS) as ExtensionKind[])
		.map((kind) => ({
			kind,
			label: KIND_LABELS[kind],
			items: filtered.filter((item) => item.kind === kind),
		}))
		.filter((group) => group.items.length > 0);

	const tabs: readonly { readonly id: Tab; readonly label: string; readonly count: number }[] = [
		{ id: "all", label: TAB_LABELS.all, count: items.length },
		{ id: "plugin", label: TAB_LABELS.plugin, count: counts.plugin },
		{ id: "skill", label: TAB_LABELS.skill, count: counts.skill },
		{ id: "mcp", label: TAB_LABELS.mcp, count: counts.mcp },
	];

	const pluginEntries: readonly MenuEntry[] = [
		{
			type: "item",
			key: "install",
			label: bridge === undefined ? "安装本地插件（桌面端可用）" : "安装本地插件",
			icon: PackagePlus,
			disabled: bridge === undefined,
			onSelect: () => installPlugin(),
		},
		{ type: "item", key: "market", label: "插件市场", icon: Store, onSelect: () => setInfoOpen(true) },
	];

	const installPlugin = (): void => {
		if (bridge === undefined) {
			toast("请在桌面端安装本地插件", "error");
			return;
		}
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

	const togglePlugin = (name: string, disabled: boolean): void => {
		if (bridge === undefined) {
			toast("请在桌面端管理插件", "error");
			return;
		}
		void bridge
			.togglePlugin(name, disabled)
			.then((result) => {
				if (!result.ok) {
					toast(result.error ?? "更新插件状态失败", "error");
					return;
				}
				toast(disabled ? "插件已禁用，正在重启 Reins…" : "插件已启用，正在重启 Reins…");
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			);
	};

	const uninstallPlugin = (): void => {
		const target = pluginRemoveTarget;
		if (target === undefined) return;
		if (bridge === undefined) {
			toast("请在桌面端管理插件", "error");
			return;
		}
		void bridge
			.uninstallPlugin(target.name)
			.then((result) => {
				if (!result.ok) {
					toast(result.error ?? "卸载插件失败", "error");
					return;
				}
				setPluginRemoveTarget(undefined);
				toast("插件已卸载，正在重启 Reins…");
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			);
	};

	const editMcp = (item: ExtensionItem): void => {
		void api
			.mcpServer(item.name)
			.then((server) => setMcpEditTarget(server))
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			);
	};

	const reconnectMcp = (item: ExtensionItem): void => {
		void api
			.reconnectMcpServer(item.name)
			.then((message) => {
				toast(message.length > 0 ? message : "已重连");
				onRefresh();
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			);
	};

	const deleteMcp = (): void => {
		const target = mcpDeleteTarget;
		if (target === undefined || mcpDeleting) return;
		setMcpDeleting(true);
		void api
			.deleteMcpServer(target.name)
			.then(() => {
				toast("MCP 服务器已删除");
				setMcpDeleteTarget(undefined);
				onRefresh();
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			)
			.finally(() => setMcpDeleting(false));
	};

	const deleteSkill = (): void => {
		const target = skillDeleteTarget;
		if (target === undefined || target.path === undefined || skillDeleting) return;
		setSkillDeleting(true);
		void api
			.deleteSkill(target.path)
			.then(() => {
				toast("技能已删除");
				setSkillDeleteTarget(undefined);
				onRefresh();
			})
			.catch((cause: unknown) =>
				toast(cause instanceof Error ? cause.message : String(cause), "error"),
			)
			.finally(() => setSkillDeleting(false));
	};

	return (
		<div className="flex flex-col gap-6">
			<SettingsHeader
				title="扩展管理"
				description="管理本机已安装的插件、技能与 MCP 连接。"
				action={
					tab === "plugin" ? (
						<Button
							variant="outline"
							size="sm"
							className="h-8 rounded-lg px-3 text-[12px]"
							onClick={() => setInfoOpen(true)}
						>
							<Store className="size-3.5" />
							市场
						</Button>
					) : undefined
				}
			/>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-surface p-0.5">
					{tabs.map((entry) => {
						const active = entry.id === tab;
						return (
							<button
								key={entry.id}
								type="button"
								onClick={() => setTab(entry.id)}
								aria-pressed={active}
								className={cn(
									"flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] leading-[18px] transition-colors",
									active
										? "bg-card text-foreground shadow-[0_0_0_0.5px_var(--border)] dark:bg-surface-strong"
										: "text-foreground-subtle hover:text-foreground",
								)}
							>
								{entry.label}
								<span className="rounded-full bg-surface px-1.5 text-[10px] leading-4 tabular-nums text-foreground-subtlest">
									{entry.count}
								</span>
							</button>
						);
					})}
				</div>

				<div className="flex items-center gap-2">
					<label className="flex h-8 w-[190px] items-center gap-1.5 rounded-lg border-[0.5px] border-border bg-card px-2 transition-colors focus-within:border-input-border-focused">
						<Search className="size-3.5 shrink-0 text-foreground-subtlest" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索扩展"
							aria-label="搜索扩展"
							className="min-w-0 flex-1 bg-transparent text-[12px] leading-[18px] outline-none placeholder:text-foreground-subtlest"
						/>
					</label>
					{tab === "all" ? null : tab === "skill" ? (
						<button
							type="button"
							aria-label="上传技能压缩包"
							title="上传技能压缩包"
							onClick={() => setUploadOpen(true)}
							className="flex size-8 items-center justify-center rounded-lg border-[0.5px] border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
						>
							<Upload className="size-3.5" />
						</button>
					) : tab === "plugin" ? (
						<Menu
							align="end"
							zIndex={90}
							entries={pluginEntries}
							trigger={({ open, toggle }) => (
								<button
									type="button"
									aria-label="添加插件"
									title="添加插件"
									aria-haspopup="menu"
									aria-expanded={open}
									onClick={toggle}
									className="flex size-8 items-center justify-center rounded-lg border-[0.5px] border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
								>
									<Plus className="size-3.5" />
								</button>
							)}
						/>
					) : (
						<button
							type="button"
							aria-label="添加 MCP 服务器"
							title="添加 MCP 服务器"
							onClick={() => setMcpOpen(true)}
							className="flex size-8 items-center justify-center rounded-lg border-[0.5px] border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
						>
							<Plus className="size-3.5" />
						</button>
					)}
					<button
						type="button"
						aria-label="刷新扩展"
						title="刷新扩展"
						onClick={onRefresh}
						className="flex size-8 items-center justify-center rounded-lg border-[0.5px] border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
					>
						<RefreshCw className="size-3.5" />
					</button>
				</div>
			</div>

			{settings === undefined ? (
				<div className="rounded-[16px] border-[0.5px] border-border bg-card px-4 py-6 text-[13px] leading-5 text-foreground-subtlest">
					正在读取本机扩展…
				</div>
			) : items.length === 0 || (filtered.length === 0 && !searching) ? (
				<EmptyState {...TAB_EMPTY[tab]} />
			) : filtered.length === 0 ? (
				<EmptyState
					icon={Search}
					title="没有匹配的扩展"
					description="换一个名称、描述或类型关键词试试。"
				/>
			) : (
				groups.map((group) => (
					<section key={group.kind} className="flex flex-col gap-2">
						<h2 className="m-0 flex items-center gap-1.5 px-1 text-[13px] leading-5 font-medium">
							{group.label}
							<span className="text-[11px] leading-4 font-normal text-foreground-subtlest">
								{group.items.length}
							</span>
						</h2>
						<SettingsCard>
							{group.items.map((item, index) => (
								<ExtensionRow
									key={item.key}
									item={item}
									last={index === group.items.length - 1}
									onToggle={
										item.kind === "plugin" && bridge !== undefined
											? (disabled) => togglePlugin(item.name, disabled)
											: undefined
									}
									onUninstall={
										item.kind === "plugin" && bridge !== undefined
											? () => setPluginRemoveTarget(item)
											: undefined
									}
									onLogs={
										item.kind === "plugin" ? () => setPluginLogsTarget(item) : undefined
									}
									status={mcpStatusOf(item)}
									onEdit={
										item.kind === "mcp"
											? () => editMcp(item)
											: item.kind === "skill" && item.editable === true
												? () => setSkillEditTarget(item)
												: undefined
									}
									onReconnect={item.kind === "mcp" ? () => reconnectMcp(item) : undefined}
									onDelete={
										item.kind === "mcp"
											? () => setMcpDeleteTarget(item)
											: item.kind === "skill" && item.editable === true
												? () => setSkillDeleteTarget(item)
												: undefined
									}
								/>
							))}
						</SettingsCard>
					</section>
				))
			)}

			<Dialog
				open={infoOpen}
				onClose={() => setInfoOpen(false)}
				title="安装插件"
				footer={
					<Button variant="primary" size="sm" onClick={() => setInfoOpen(false)}>
						知道了
					</Button>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">插件市场尚未接入，当前版本不能从这里检索或安装插件。</p>
					<p className="m-0">
						桌面端可以在「+」里从本地安装；也可以把插件放入 Reins 配置目录下的 plugins/
						后重启 Reins。
					</p>
					<p className="m-0 text-foreground-subtlest">这里只展示 Reins 实际装载的插件，不会列出虚构的市场条目。</p>
				</div>
			</Dialog>

			{skillEditTarget?.path === undefined ? null : (
				<SkillDialog
					open
					skill={{ path: skillEditTarget.path, name: skillEditTarget.name }}
					onClose={() => setSkillEditTarget(undefined)}
					onSaved={onRefresh}
				/>
			)}
			<SkillUploadDialog
				open={uploadOpen}
				onClose={() => setUploadOpen(false)}
				onCreated={onRefresh}
			/>
			<McpServerDialog
				open={mcpOpen}
				onClose={() => setMcpOpen(false)}
				onCreated={onRefresh}
			/>

			<Dialog
				open={pluginRemoveTarget !== undefined}
				onClose={() => setPluginRemoveTarget(undefined)}
				title="卸载插件"
				footer={
					<>
						<Button variant="outline" size="sm" onClick={() => setPluginRemoveTarget(undefined)}>
							取消
						</Button>
						<Button variant="danger" size="sm" onClick={uninstallPlugin}>
							卸载
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">卸载会删除插件目录，不能撤销。</p>
					<p className="m-0 text-foreground">{pluginRemoveTarget?.name}</p>
				</div>
			</Dialog>

			<PluginLogsDialog
				name={pluginLogsTarget?.name}
				onClose={() => setPluginLogsTarget(undefined)}
			/>

			<McpServerDialog
				open={mcpEditTarget !== undefined}
				server={mcpEditTarget}
				onClose={() => setMcpEditTarget(undefined)}
				onCreated={onRefresh}
			/>

			<Dialog
				open={mcpDeleteTarget !== undefined}
				onClose={() => setMcpDeleteTarget(undefined)}
				title="删除 MCP 服务器"
				footer={
					<>
						<Button variant="outline" size="sm" disabled={mcpDeleting} onClick={() => setMcpDeleteTarget(undefined)}>
							取消
						</Button>
						<Button variant="danger" size="sm" disabled={mcpDeleting} onClick={deleteMcp}>
							{mcpDeleting ? "删除中…" : "删除"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">删除会从 config.toml 移除这个服务器，并立即断开连接；不能撤销。</p>
					<p className="m-0 text-foreground">{mcpDeleteTarget?.name}</p>
				</div>
			</Dialog>

			<Dialog
				open={skillDeleteTarget !== undefined}
				onClose={() => setSkillDeleteTarget(undefined)}
				title="删除技能"
				footer={
					<>
						<Button
							variant="outline"
							size="sm"
							disabled={skillDeleting}
							onClick={() => setSkillDeleteTarget(undefined)}
						>
							取消
						</Button>
						<Button variant="danger" size="sm" disabled={skillDeleting} onClick={deleteSkill}>
							{skillDeleting ? "删除中…" : "删除"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">删除会移除技能目录与 SKILL.md，不能撤销。</p>
					<p className="m-0 text-foreground">{skillDeleteTarget?.name}</p>
				</div>
			</Dialog>
		</div>
	);
}

function ExtensionRow({
	item,
	last,
	onToggle,
	onUninstall,
	onLogs,
	onEdit,
	onReconnect,
	onDelete,
	status,
}: {
	readonly item: ExtensionItem;
	readonly last: boolean;
	onToggle?(disabled: boolean): void;
	onUninstall?(): void;
	onLogs?(): void;
	onEdit?(): void;
	onReconnect?(): void;
	onDelete?(): void;
	readonly status?: McpStatusView;
}): ReactElement {
	const Icon = KIND_ICONS[item.kind];
	const menuEntries: MenuEntry[] = [];
	if (onEdit !== undefined) {
		menuEntries.push({ type: "item", key: "edit", label: "编辑", icon: Pencil, onSelect: onEdit });
	}
	if (onReconnect !== undefined) {
		menuEntries.push({
			type: "item",
			key: "reconnect",
			label: "重连",
			icon: RefreshCw,
			onSelect: onReconnect,
		});
	}
	if (onDelete !== undefined) {
		menuEntries.push({
			type: "item",
			key: "delete",
			label: "删除",
			icon: Trash2,
			danger: true,
			onSelect: onDelete,
		});
	}

	return (
		<div
			className={cn(
				"flex items-center gap-3 px-4 py-3",
				last ? undefined : "border-b-[0.5px] border-border",
			)}
		>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
				<Icon className="size-4" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					{status === undefined ? null : <StateDot state={status.state} />}
					<span className="min-w-0 truncate text-[13px] leading-5 font-medium">{item.name}</span>
					{item.disabled ? <Badge tone="muted">已禁用</Badge> : null}
					{item.kind === "skill" && item.editable === false ? (
						<Badge tone="muted">只读</Badge>
					) : null}
				</div>
				<div className="truncate text-[12px] leading-[18px] text-foreground-subtlest">
					{item.description}
				</div>
				{status === undefined ? null : (
					<div className="truncate text-[11px] leading-4 text-foreground-subtlest">
						{status.label}
						{status.detail.length === 0 ? "" : ` · ${status.detail}`}
					</div>
				)}
			</div>
			<span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] leading-4 text-foreground-subtle">
				{item.meta}
			</span>
			{onToggle === undefined ? (
				status !== undefined || item.kind === "skill" ? null : item.disabled ? (
					<Minus className="size-3.5 shrink-0 text-foreground-subtlest" aria-label="已禁用" />
				) : (
					<Check className="size-4 shrink-0 text-foreground-subtle" aria-label="已启用" />
				)
			) : (
				<Switch
					checked={!item.disabled}
					onCheckedChange={(checked) => onToggle(!checked)}
					label={item.disabled ? `启用插件 ${item.name}` : `禁用插件 ${item.name}`}
				/>
			)}
			{menuEntries.length === 0 ? null : (
				<Menu
					align="end"
					zIndex={90}
					entries={menuEntries}
					trigger={({ open, toggle }) => (
						<button
							type="button"
							aria-label={`管理 ${item.name}`}
							title="更多操作"
							aria-haspopup="menu"
							aria-expanded={open}
							onClick={toggle}
							className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
						>
							<MoreHorizontal className="size-4" />
						</button>
					)}
				/>
			)}
			{onLogs === undefined ? null : (
				<button
					type="button"
					aria-label={`查看插件 ${item.name} 的日志`}
					title="查看日志"
					onClick={onLogs}
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
				>
					<ScrollText className="size-3.5" />
				</button>
			)}
			{onUninstall === undefined ? null : (
				<button
					type="button"
					aria-label={`卸载插件 ${item.name}`}
					title="卸载插件"
					onClick={onUninstall}
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-destructive-surface hover:text-destructive"
				>
					<Trash2 className="size-3.5" />
				</button>
			)}
		</div>
	);
}
