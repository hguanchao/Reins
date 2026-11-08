import type { ReactElement } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { sandboxLabel } from "../lib/format.ts";
import type { SettingsSnapshot } from "../protocol.ts";
import { Card, Row, Section, SettingsPane, Tag } from "./controls.tsx";

/** 关于：版本、配置位置与运行方式。只读，只留「检查更新」「导出诊断包」两个动作。 */
export function AboutSection({
	settings,
}: {
	readonly settings: SettingsSnapshot | undefined;
}): ReactElement {
	return (
		<SettingsPane eyebrow="SETTINGS / ABOUT" title="关于 Reins" description="版本、本机配置位置与运行方式。">
			<Section name="版本">
				<Card>
					<div style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
						<BrandMark size={38} />
						<div style={{ flex: 1, minWidth: 0 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 7 }}>
								<span style={{ fontSize: "var(--fs-20)", fontWeight: 600, letterSpacing: "0.01em" }}>
									Reins
								</span>
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
					/>
					<Row title="诊断信息" description="导出运行环境、扩展清单与最近日志，便于排查问题。" />
				</Card>
			</Section>
		</SettingsPane>
	);
}
