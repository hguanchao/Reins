import { Blocks, FileText, MoreVertical, Pencil, Puzzle, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Dialog, Menu, Switch, toast, type MenuEntry } from "../components/ui/index.ts";
import type { McpServerInput, SettingsSnapshot } from "../protocol.ts";
import { desktopBridge } from "../platform.ts";
import { Card, Empty, Section, SettingsPane, Tag } from "./controls.tsx";
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

const TAB_LABELS: Record<Tab, string> = { all: "全部", plugin: "插件", skill: "技能", mcp: "MCP" };
const KIND_LABELS: Record<ExtensionKind, string> = { plugin: "插件", skill: "技能", mcp: "MCP 服务器" };

/**
 * 扩展管理。
 *
 * 页签只做过滤（带数量），清单仍按类型分组——技能、MCP 与插件的心智不同，混在一起读不出
 * 「我在管什么」。MCP 状态用徽标陈述（已连接 / 连接失败），不用彩色点。
 */
export function ExtensionsSection({
	settings,
	onRefresh,
}: {
	readonly settings: SettingsSnapshot | undefined;
	onRefresh(): void;
}): ReactElement {
	const [tab, setTab] = useState<Tab>("all");
	const [query, setQuery] = useState("");
	const [uploadOpen, setUploadOpen] = useState(false);
	const [mcpOpen, setMcpOpen] = useState(false);
	/** 编辑要读回命令 / 地址 / 环境变量；只带名字打开会把原有配置写空 */
	const [mcpEdit, setMcpEdit] = useState<McpServerInput | undefined>(undefined);
	const [mcpDelete, setMcpDelete] = useState<ExtensionItem | undefined>(undefined);
	const [skillEdit, setSkillEdit] = useState<ExtensionItem | undefined>(undefined);
	const [skillDelete, setSkillDelete] = useState<ExtensionItem | undefined>(undefined);
	const [logs, setLogs] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [toggling, setToggling] = useState<string | undefined>(undefined);
	// 启停插件要改本机配置并重启服务，只有桌面壳提供这条通道
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
		.map((kind) => ({ kind, label: KIND_LABELS[kind], items: filtered.filter((item) => item.kind === kind) }))
		.filter((group) => group.items.length > 0);

	const deleteMcp = (): void => {
		const target = mcpDelete;
		if (target === undefined || busy) return;
		setBusy(true);
		void api
			.deleteMcpServer(target.name)
			.then(() => {
				setMcpDelete(undefined);
				onRefresh();
			})
			.finally(() => setBusy(false));
	};

	const deleteSkill = (): void => {
		const target = skillDelete;
		if (target === undefined || target.path === undefined || busy) return;
		setBusy(true);
		void api
			.deleteSkill(target.path)
			.then(() => {
				setSkillDelete(undefined);
				onRefresh();
			})
			.finally(() => setBusy(false));
	};

	const togglePlugin = (name: string, enabled: boolean): void => {
		if (bridge === undefined || toggling !== undefined) return;
		setToggling(name);
		void bridge
			.togglePlugin(name, !enabled)
			.then((result) => {
				if (!result.ok) {
					toast(result.error ?? `${name} 的启用状态没有写入`, "error");
					return;
				}
				toast(`${enabled ? "已启用" : "已禁用"} ${name}，服务重启后生效`);
				onRefresh();
			})
			.catch((cause: unknown) => {
				toast(cause instanceof Error ? cause.message : String(cause), "error");
			})
			.finally(() => setToggling(undefined));
	};

	const openMcpEdit = (name: string): void => {
		void api
			.mcpServer(name)
			.then((detail) => setMcpEdit(detail))
			.catch((cause: unknown) => {
				toast(cause instanceof Error ? cause.message : String(cause), "error");
			});
	};

	return (
		<SettingsPane
			eyebrow="SETTINGS / EXTENSIONS"
			title="扩展管理"
			description="管理本机已装载的插件、技能与 MCP 连接。装载后从下一回合开始可用。"
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 26, marginBottom: 4 }}>
				<div className="xtabs" role="tablist">
					{(["all", "plugin", "skill", "mcp"] as const).map((key) => (
						<button
							key={key}
							type="button"
							role="tab"
							aria-selected={key === tab}
							className="xtab"
							onClick={() => setTab(key)}
						>
							{TAB_LABELS[key]}
							<span className="c">{key === "all" ? items.length : counts[key as ExtensionKind]}</span>
						</button>
					))}
				</div>
				<span style={{ flex: 1 }} />
				<div className="input-line" style={{ width: 150, background: "var(--raise)" }}>
					<svg
						className="ic ic-12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="m21 21-4.34-4.34" />
						<circle cx="11" cy="11" r="8" />
					</svg>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索扩展"
						aria-label="搜索扩展"
						style={{ fontFamily: "var(--sans)", fontSize: "var(--fs-11)" }}
					/>
				</div>
				{tab === "skill" ? (
					<button type="button" className="b b-line b-sm" onClick={() => setUploadOpen(true)}>
						上传技能
					</button>
				) : tab === "mcp" ? (
					<button type="button" className="b b-line b-sm" onClick={() => setMcpOpen(true)}>
						添加连接器
					</button>
				) : null}
			</div>

			{settings === undefined ? (
				<p className="set-note">正在读取本机扩展…</p>
			) : items.length === 0 ? (
				<Empty
					icon={Blocks}
					title="还没有装载扩展"
					description="Reins 的核心能力全部内置；插件、技能与 MCP 服务器装载后会出现在这里。"
				/>
			) : filtered.length === 0 ? (
				searching ? (
					<Empty icon={Blocks} title="没有匹配的扩展" description="换一个名称、描述或类型关键词试试。" />
				) : (
					<Empty
						icon={Blocks}
						title={`还没有装载${tab === "all" ? "扩展" : TAB_LABELS[tab]}`}
						description={`这里只列出实际装载的${tab === "all" ? "扩展" : KIND_LABELS[tab]}；装载后会出现在这个分类下。`}
					/>
				)
			) : (
				groups.map((group) => (
					<Section key={group.kind} name={group.label} hint={String(group.items.length)}>
						<Card>
							{group.items.map((item) => (
								<div key={item.key} className="ext">
									<span className="mk">
										<Puzzle className="ic ic-14" />
									</span>
									<div className="tx">
										<div className="n">
											{item.name}
											{item.kind === "skill" ? (
												<Tag tone="ghost">{item.scope === "project" ? "项目级" : "用户级"}</Tag>
											) : item.kind === "mcp" ? (
												<Tag tone={item.status === "connected" ? "line" : "dash"}>
													{statusLabel(item.status)}
												</Tag>
											) : bridge === undefined ? (
												item.disabled ? (
													<Tag tone="dash">已禁用</Tag>
												) : (
													<Tag tone="ghost">已启用</Tag>
												)
											) : null}
										</div>
										<div className="d">{item.detail ?? item.description}</div>
									</div>
									<span className="m">{item.meta}</span>
									{item.kind === "plugin" && bridge !== undefined ? (
										<Switch
											checked={!item.disabled}
											label={`${item.disabled ? "启用" : "禁用"} ${item.name}`}
											disabled={toggling !== undefined}
											onCheckedChange={(enabled) => togglePlugin(item.name, enabled)}
										/>
									) : null}
									<RowActions
										kind={item.kind}
										onEdit={
											item.kind === "mcp"
												? () => openMcpEdit(item.name)
												: item.kind === "skill" && item.editable === true
													? () => setSkillEdit(item)
													: undefined
										}
										onLogs={item.kind === "plugin" ? () => setLogs(item.name) : undefined}
										onDelete={
											item.kind === "mcp"
												? () => setMcpDelete(item)
												: item.kind === "skill" && item.editable === true
													? () => setSkillDelete(item)
													: undefined
										}
									/>
								</div>
							))}
						</Card>
					</Section>
				))
			)}

			<p className="set-note">这里只展示实际装载的扩展，不列出市场条目；插件启用或禁用会重启 Reins。</p>

			<SkillUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onCreated={onRefresh} />
			<McpServerDialog open={mcpOpen} onClose={() => setMcpOpen(false)} onCreated={onRefresh} />
			<McpServerDialog
				open={mcpEdit !== undefined}
				server={mcpEdit}
				onClose={() => setMcpEdit(undefined)}
				onCreated={onRefresh}
			/>
			{skillEdit?.path === undefined ? null : (
				<SkillDialog
					open
					skill={{ path: skillEdit.path, name: skillEdit.name }}
					onClose={() => setSkillEdit(undefined)}
					onSaved={onRefresh}
				/>
			)}
			<PluginLogsDialog name={logs} onClose={() => setLogs(undefined)} />

			<Dialog
				open={mcpDelete !== undefined}
				onClose={() => setMcpDelete(undefined)}
				title="删除连接器"
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setMcpDelete(undefined)}>
							取消
						</button>
						<button type="button" className="b b-danger" disabled={busy} onClick={deleteMcp}>
							删除
						</button>
					</>
				}
			>
				<p style={{ margin: 0 }}>删除会从 config.toml 移除这个服务器并立即断开连接；不能撤销。</p>
				<p style={{ margin: 0, color: "var(--ink)" }}>{mcpDelete?.name}</p>
			</Dialog>

			<Dialog
				open={skillDelete !== undefined}
				onClose={() => setSkillDelete(undefined)}
				title="删除技能"
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setSkillDelete(undefined)}>
							取消
						</button>
						<button type="button" className="b b-danger" disabled={busy} onClick={deleteSkill}>
							删除
						</button>
					</>
				}
			>
				<p style={{ margin: 0 }}>删除会移除技能目录与 SKILL.md，不能撤销。</p>
				<p style={{ margin: 0, color: "var(--ink)" }}>{skillDelete?.name}</p>
			</Dialog>
		</SettingsPane>
	);
}

function statusLabel(status: string | undefined): string {
	switch (status) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "unreachable":
			return "连接失败";
		case "disabled":
			return "已禁用";
		default:
			return "未连接";
	}
}

/** 行尾动作：单枚溢出钮，展开 编辑 / 日志 / 删除；没有可用动作时整组不出现。 */
function RowActions({
	kind,
	onEdit,
	onLogs,
	onDelete,
}: {
	readonly kind: ExtensionKind;
	onEdit?: () => void;
	onLogs?: () => void;
	onDelete?: () => void;
}): ReactElement | null {
	if (onEdit === undefined && onLogs === undefined && onDelete === undefined) {
		return kind === "skill" ? <span className="m">只读</span> : null;
	}
	const entries: MenuEntry[] = [
		...(onEdit === undefined ? [] : [{ type: "item" as const, key: "edit", label: "编辑", icon: Pencil, onSelect: onEdit }]),
		...(onLogs === undefined
			? []
			: [{ type: "item" as const, key: "logs", label: "查看日志", icon: FileText, onSelect: onLogs }]),
		...(onEdit === undefined && onLogs === undefined ? [] : [{ type: "separator" as const }]),
		...(onDelete === undefined
			? []
			: [{ type: "item" as const, key: "delete", label: "删除", icon: Trash2, danger: true, onSelect: onDelete }]),
	];
	return (
		<Menu
			align="end"
			entries={entries}
			trigger={({ toggle, open }) => (
				<button
					type="button"
					className="more"
					title="更多操作"
					aria-label="更多操作"
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={toggle}
				>
					<MoreVertical className="ic ic-14" />
				</button>
			)}
		/>
	);
}
