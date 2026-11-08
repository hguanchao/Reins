import { useEffect, useRef, useState, type ReactElement } from "react";

import { sandboxLabel } from "../lib/format.ts";
import type { ApprovalMode, NotifyMode, SettingsSnapshot } from "../protocol.ts";
import { Card, ChoiceCard, Row, Section, SettingsPane, Tag } from "./controls.tsx";

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
	ask: "逐次询问",
	auto: "自动审查",
	yolo: "直接放行",
};

const APPROVAL_HINTS: Record<ApprovalMode, string> = {
	ask: "每次写盘或执行命令都停下确认。最稳，打断也最多。",
	auto: "先由审查模型判断，风险高才问你。工作区内的常规改动直接放行。",
	yolo: "不再询问。路径边界与不可逆操作的拦截仍然生效。",
};

const NOTIFY_OPTIONS: readonly { readonly key: NotifyMode; readonly label: string; readonly hint: string }[] = [
	{ key: "auto", label: "失焦时", hint: "只在窗口不在前台时提醒" },
	{ key: "bell", label: "响铃", hint: "只在终端里生效" },
	{ key: "desktop", label: "桌面通知", hint: "每次都提醒" },
	{ key: "off", label: "关闭", hint: "不再提醒" },
];

/**
 * 常规。
 *
 * 审批方式用三张并排选择卡：三个选项的差别在「打断程度」，必须并排比较；选中卡描边压深并
 * 给出勾。其余运行环境项是只读事实，用徽标陈述而不是做成灰色不可用的控件。
 */
export function GeneralSection({
	settings,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot | undefined;
	onUpdate(update: { approval?: ApprovalMode; notify?: NotifyMode }): void;
}): ReactElement {
	const [notifyOpen, setNotifyOpen] = useState(false);
	const notifyRef = useRef<HTMLDivElement | null>(null);
	const current = settings?.notify ?? "auto";
	const currentLabel = NOTIFY_OPTIONS.find((option) => option.key === current)?.label ?? "失焦时";

	useEffect(() => {
		if (!notifyOpen) return;
		const onDown = (event: MouseEvent): void => {
			if (notifyRef.current !== null && !notifyRef.current.contains(event.target as Node)) setNotifyOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [notifyOpen]);

	return (
		<SettingsPane
			eyebrow="SETTINGS / GENERAL"
			title="常规"
			description="审批策略、通知与运行环境。改动立即写回本机配置，不需要重启。"
		>
			<Section name="审批方式" hint="模型动文件、跑命令之前，要不要先问你">
				<div className="set-choices">
					{(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
						<ChoiceCard
							key={mode}
							title={APPROVAL_LABELS[mode]}
							description={APPROVAL_HINTS[mode]}
							selected={(settings?.approval ?? "ask") === mode}
							onSelect={() => onUpdate({ approval: mode })}
						/>
					))}
				</div>
				<p className="set-note">审批策略立即生效并写回 config.toml；已经开始的回合不受影响。</p>
			</Section>

			<Section name="通知">
				<Card>
					<Row
						title="通知时机"
						description="任务完成、失败与等待审批时的提醒；响铃只在终端里生效。"
					>
						<div ref={notifyRef} style={{ position: "relative", flex: "none", width: 150 }}>
							<button
								type="button"
								className="input-line"
								style={{ width: "100%", background: "var(--raise)", cursor: "pointer" }}
								aria-haspopup="listbox"
								aria-expanded={notifyOpen}
								aria-label="通知时机"
								onClick={() => setNotifyOpen((value) => !value)}
							>
								<span className="t" style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-11)" }}>
									{currentLabel}
								</span>
								<svg
									className="ic-12 chev"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="m6 9 6 6 6-6" />
								</svg>
							</button>
							{notifyOpen ? (
								<div
									className="pop animate-pop"
									role="listbox"
									style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: "100%", zIndex: 30 }}
								>
									{NOTIFY_OPTIONS.map((option) => (
										<button
											key={option.key}
											type="button"
											role="option"
											aria-selected={option.key === current}
											className="pop-i two"
											style={option.key === current ? { background: "var(--wash-2)" } : undefined}
											onClick={() => {
												onUpdate({ notify: option.key });
												setNotifyOpen(false);
											}}
										>
											<span className="sk-col">
												<span className="n">{option.label}</span>
												<span className="d">{option.hint}</span>
											</span>
											{option.key === current ? (
												<svg
													className="ic-12 ck"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
													aria-hidden="true"
												>
													<path d="M20 6 9 17l-5-5" />
												</svg>
											) : null}
										</button>
									))}
								</div>
							) : null}
						</div>
					</Row>
				</Card>
				<p className="set-note">「失焦时」只在窗口不在前台时提醒；「桌面通知」每次都提醒。</p>
			</Section>

			<Section name="运行环境">
				<Card>
					<Row
						title="沙箱模式"
						description="命令隔离使用的系统设施；改动需要重启。"
						value={<Tag>{sandboxLabel(settings?.sandbox ?? "off")}</Tag>}
					/>
					<Row
						title="路径边界"
						description="文件读写与命令工作目录都由内核校验，插件不能绕过。"
						value={<Tag>Reins 内置</Tag>}
					/>
					<Row title="界面语言" description="当前版本只提供简体中文。" value={<Tag>简体中文</Tag>} />
				</Card>
			</Section>

			<Section name="任务列表">
				<Card>
					<Row title="分组方式" description="侧栏任务区按项目归类。" value={<span className="v">按项目</span>} />
					<Row title="排序" description="各组内按最近更新时间排列。" value={<span className="v">最近更新</span>} />
				</Card>
				<p className="set-note">分组与排序当前固定；自定义选项尚未接入。</p>
			</Section>
		</SettingsPane>
	);
}
