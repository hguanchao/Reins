import type { ReactElement } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { sandboxLabel } from "../lib/format.ts";
import type { SettingsSnapshot } from "../protocol.ts";
import { Badge, SettingRow, SettingsCard, SettingsHeader } from "./controls.tsx";

/** 关于：版本、配置位置与本地模式说明。 */
export function AboutSection({
	settings,
}: {
	readonly settings: SettingsSnapshot | undefined;
}): ReactElement {
	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader title="关于 Reins" description="版本、本机配置位置与运行方式。" />

			<div className="flex items-center gap-3.5 rounded-[16px] border-[0.5px] border-border bg-card px-5 py-5">
				<BrandMark size={40} />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[18px] leading-6 font-semibold tracking-[0.02em]">Reins</span>
						<Badge tone="muted">预览版</Badge>
					</div>
					<div className="mt-0.5 text-[12px] leading-[18px] text-foreground-subtlest">
						本地运行的编码 Agent · v{settings?.version ?? "—"}
					</div>
				</div>
				<Badge tone="success">无需登录</Badge>
			</div>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">本机配置</h2>
				<SettingsCard>
					<SettingRow title="配置文件" description="用户级 config.toml 的位置。">
						<span className="max-w-[360px] break-all text-right font-mono text-[11px] leading-4 text-foreground-subtle">
							{settings?.configPath ?? "—"}
						</span>
					</SettingRow>
					<SettingRow title="提供方配置" description="用户级 providers.json 的位置。">
						<span className="max-w-[360px] break-all text-right font-mono text-[11px] leading-4 text-foreground-subtle">
							{settings?.providersPath ?? "—"}
						</span>
					</SettingRow>
					<SettingRow title="沙箱模式" description="命令隔离使用的系统设施。">
						<Badge>{sandboxLabel(settings?.sandbox ?? "off")}</Badge>
					</SettingRow>
					<SettingRow title="数据位置" description="任务、技能、插件与检查点都保存在本机配置目录。">
						<Badge>仅本机</Badge>
					</SettingRow>
				</SettingsCard>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">运行方式</h2>
				<p className="m-0 rounded-[16px] border-[0.5px] border-border bg-card px-4 py-3.5 text-[12px] leading-[18px] text-foreground-subtle">
					Reins 的界面与内核共用同一份权限判定、路径边界和工具链。没有云端账号体系，API Key
					与模型配置都保存在本机；卸载或清理配置目录之前，任务记录不会离开这台机器。
				</p>
			</section>
		</div>
	);
}
