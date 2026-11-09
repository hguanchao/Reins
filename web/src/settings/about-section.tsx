import type { ReactElement } from "react";

import { toast } from "../components/ui/index.ts";
import { sandboxLabel } from "../lib/format.ts";
import type { SettingsSnapshot } from "../protocol.ts";
import { Card, Row, Section, SettingsPane, Tag } from "./controls.tsx";

/** 诊断包只收界面能拿到的运行信息：不探测网络、不读日志文件，导出的内容与页面一致。 */
function diagnostics(settings: SettingsSnapshot | undefined): string {
	const at = new Date();
	return JSON.stringify(
		{
			exportedAt: at.toISOString(),
			version: settings?.version,
			configPath: settings?.configPath,
			providersPath: settings?.providersPath,
			sandbox: settings?.sandbox,
			provider: settings?.provider,
			model: settings?.model,
			counts: {
				models: settings?.models.length ?? 0,
				skills: settings?.skills.length ?? 0,
				mcpServers: settings?.mcpServers.length ?? 0,
				plugins: settings?.plugins.length ?? 0,
			},
			runtime: navigator.userAgent,
		},
		null,
		2,
	);
}

/** 关于：版本、配置位置与运行方式。设计稿在此页只留「检查更新」「导出诊断包」两个动作。 */
export function AboutSection({
	settings,
}: {
	readonly settings: SettingsSnapshot | undefined;
}): ReactElement {
	const exportDiagnostics = (): void => {
		const url = URL.createObjectURL(new Blob([diagnostics(settings)], { type: "application/json" }));
		const link = document.createElement("a");
		const at = new Date();
		link.href = url;
		link.download = `reins-diagnostics-${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, "0")}${String(
			at.getDate(),
		).padStart(2, "0")}.json`;
		link.click();
		URL.revokeObjectURL(url);
		toast("诊断信息已导出");
	};

	return (
		<SettingsPane eyebrow="SETTINGS / ABOUT" title="关于 Reins" description="版本、本机配置位置与运行方式。">
			<Section name="版本">
				<Card>
					<div style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
						<span
							className="brandmark"
							style={{ width: 38, height: 38, fontSize: "var(--fs-16)", borderRadius: "var(--r-2)" }}
						>
							R
						</span>
						<div style={{ flex: 1, minWidth: 0 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 7 }}>
								<span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "0.01em" }}>Reins</span>
								<span className="badge">预览版</span>
							</div>
							<div style={{ marginTop: 3, fontSize: "var(--fs-11)", color: "var(--ink-4)" }}>
								本地运行的编码 Agent · v{settings?.version ?? "—"}
							</div>
						</div>
						<span className="badge solid lg">无需登录</span>
					</div>
				</Card>
			</Section>

			<Section name="本机配置">
				<Card>
					<Row
						title="配置文件"
						description="用户级 config.toml 的位置。"
						value={<span className="v mono">{settings?.configPath ?? "—"}</span>}
					/>
					<Row
						title="提供方配置"
						description="用户级 providers.json 的位置。"
						value={<span className="v mono">{settings?.providersPath ?? "—"}</span>}
					/>
					<Row
						title="沙箱模式"
						description="命令隔离使用的系统设施。"
						value={<Tag>{sandboxLabel(settings?.sandbox ?? "off")}</Tag>}
					/>
					<Row
						title="数据位置"
						description="任务、技能、插件与检查点都保存在本机配置目录。"
						value={<Tag>仅本机</Tag>}
					/>
				</Card>
			</Section>

			<Section name="运行方式">
				<p
					className="set-note"
					style={{
						margin: 0,
						padding: "13px 14px",
						border: "1px solid var(--rule-2)",
						borderRadius: "var(--r-3)",
						background: "var(--raise)",
						fontSize: "var(--fs-12)",
						lineHeight: 1.75,
						color: "var(--ink-3)",
					}}
				>
					界面与内核共用同一份权限判定、路径边界和工具链。没有云端账号体系，API Key
					与模型配置都保存在本机；清理配置目录之前，任务记录不会离开这台机器。
				</p>
			</Section>

			<Section name="更新">
				<Card>
					<Row
						title="当前版本"
						description="预览版不自动更新；新版本需要手动下载覆盖。"
						value={<span className="v mono">v{settings?.version ?? "—"}</span>}
						action={
							<button
								type="button"
								className="b b-line b-sm"
								onClick={() => toast("预览版不自动更新；新版本需要手动下载覆盖")}
							>
								检查更新
							</button>
						}
					/>
					<Row
						title="诊断信息"
						description="导出运行环境、扩展清单与本机配置位置，便于排查问题。"
						action={
							<button type="button" className="b b-line b-sm" onClick={exportDiagnostics}>
								导出诊断包
							</button>
						}
					/>
				</Card>
			</Section>
		</SettingsPane>
	);
}
