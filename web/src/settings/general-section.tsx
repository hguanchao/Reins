import { Check } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";
import { sandboxLabel } from "../lib/format.ts";
import type { ApprovalMode, SettingsSnapshot } from "../protocol.ts";
import { Badge, SettingRow, SettingsCard, SettingsHeader } from "./controls.tsx";

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
	ask: "逐次询问",
	auto: "自动审查",
	yolo: "直接放行",
};

const APPROVAL_HINTS: Record<ApprovalMode, string> = {
	ask: "每次改动文件或执行命令前询问",
	auto: "由审查模型判断，风险较高时再询问",
	yolo: "不询问，直接执行",
};

/** 常规：审批策略立即生效，其余运行环境与会话行为只读展示当前实现。 */
export function GeneralSection({
	settings,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot | undefined;
	onUpdate(update: { approval?: ApprovalMode }): void;
}): ReactElement {
	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader
				title="常规"
				description="审批策略、运行环境与侧栏任务列表的基础行为。"
			/>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">审批方式</h2>
				<div className="grid gap-2 sm:grid-cols-3">
					{(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => {
						const active = (settings?.approval ?? "ask") === mode;
						return (
							<button
								key={mode}
								type="button"
								onClick={() => onUpdate({ approval: mode })}
								className={cn(
									"flex flex-col items-start gap-1 rounded-[14px] border-[0.5px] px-3.5 py-3 text-left transition-colors",
									active
										? "border-foreground bg-surface"
										: "border-border bg-card hover:bg-surface-hover",
								)}
							>
								<span className="flex w-full items-center gap-2">
									<span className="min-w-0 flex-1 text-[13px] leading-5 font-medium">
										{APPROVAL_LABELS[mode]}
									</span>
									{active ? <Check className="size-3.5 shrink-0" /> : null}
								</span>
								<span className="text-[11px] leading-4 text-foreground-subtlest">
									{APPROVAL_HINTS[mode]}
								</span>
							</button>
						);
					})}
				</div>
				<p className="m-0 px-1 text-[11px] leading-4 text-foreground-subtlest">
					审批策略立即生效，并写回本机配置。
				</p>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">运行环境</h2>
				<SettingsCard>
					<SettingRow title="沙箱模式" description="命令隔离使用的系统设施；改动需要重启 Reins。">
						<Badge>{sandboxLabel(settings?.sandbox ?? "off")}</Badge>
					</SettingRow>
					<SettingRow title="路径边界" description="文件读写与命令工作目录都由 Reins 校验，插件不能绕过。">
						<span className="text-[12px] leading-[18px] text-foreground-subtle">Reins 内置</span>
					</SettingRow>
					<SettingRow title="界面语言" description="当前版本只提供简体中文。">
						<Badge>简体中文</Badge>
					</SettingRow>
				</SettingsCard>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">任务列表</h2>
				<SettingsCard>
					<SettingRow title="分组方式" description="侧栏任务区按项目分组。">
						<Badge>按项目</Badge>
					</SettingRow>
					<SettingRow title="排序" description="各分组内按最近更新时间排列。">
						<Badge>按更新时间</Badge>
					</SettingRow>
				</SettingsCard>
				<p className="m-0 px-1 text-[11px] leading-4 text-foreground-subtlest">
					分组与排序当前固定为上述行为，自定义选项尚未接入。
				</p>
			</section>
		</div>
	);
}
