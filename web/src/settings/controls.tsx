import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

/**
 * 设置页骨架。
 *
 * 八页共用一套：等宽小标 + 27px 标题 + 一句说明 + 2px 墨线，正文用行式卡片承载。
 * 不画卡片外框包住整页——标题本身就是分隔。
 */
export function SettingsPane({
	eyebrow,
	title,
	description,
	action,
	children,
}: {
	readonly eyebrow: string;
	readonly title: string;
	readonly description: string;
	readonly action?: ReactNode;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<div className="set-pane">
			<div className="set-hd">
				<div className="row">
					<div>
						<div className="eyebrow">{eyebrow}</div>
						<h1>{title}</h1>
						<p>{description}</p>
					</div>
					{action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
				</div>
			</div>
			{children}
		</div>
	);
}

/** 一个设置小节：小标题 + 右侧一句说明（可省）+ 内容 + 底部注记。 */
export function Section({
	name,
	hint,
	children,
	note,
}: {
	readonly name: string;
	readonly hint?: string;
	readonly children: ReactNode;
	/** 小节下方的补充说明，用最弱明度，不承载唯一操作信息 */
	readonly note?: ReactNode;
}): ReactElement {
	return (
		<div className="set-sec">
			<div className="set-sec-h">
				<span className="n">{name}</span>
				{hint === undefined ? null : <span className="h">{hint}</span>}
			</div>
			{children}
			{note === undefined ? null : <p className="set-note">{note}</p>}
		</div>
	);
}

/** 行式卡片：标题与说明在左，状态 / 开关 / 按钮统一靠右。 */
export function Card({ children }: { readonly children: ReactNode }): ReactElement {
	return <div className="set-card">{children}</div>;
}

export function Row({
	title,
	description,
	value,
	action,
	children,
	lead,
}: {
	readonly title: string;
	readonly description?: string;
	/** 只读读数：等宽小字或徽标 */
	readonly value?: ReactNode;
	/** 行尾的动作按钮 */
	readonly action?: ReactNode;
	readonly children?: ReactNode;
	/** 行首的序号或图标 */
	readonly lead?: ReactNode;
}): ReactElement {
	return (
		<div className="set-row">
			{lead}
			<div className="txt">
				<div className="t">{title}</div>
				{description === undefined ? null : <div className="d">{description}</div>}
			</div>
			{value}
			{action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
			{children}
		</div>
	);
}

/** 并排选择卡：三个选项的差别在「打断程度」，必须并排比较。 */
export function ChoiceCard({
	title,
	description,
	selected,
	onSelect,
}: {
	readonly title: string;
	readonly description: string;
	readonly selected: boolean;
	onSelect(): void;
}): ReactElement {
	return (
		<button type="button" className="choice" aria-pressed={selected} onClick={onSelect}>
			<span className="ct">
				{title}
				<svg
					className="ic ic-12 ck"
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
			</span>
			<span className="cd">{description}</span>
		</button>
	);
}

/** 徽标：状态用徽标而不是彩色圆点。 */
export function Tag({
	children,
	tone = "line",
}: {
	readonly children: ReactNode;
	readonly tone?: "line" | "solid" | "ghost" | "dash";
}): ReactElement {
	return <span className={`badge lg${tone === "line" ? "" : ` ${tone}`}`}>{children}</span>;
}

/** 空态：图标框 + 一句标题 + 一句说明 + 一个动作。 */
export function Empty({
	icon: Icon,
	title,
	description,
	action,
}: {
	readonly icon: LucideIcon;
	readonly title: string;
	readonly description: string;
	readonly action?: ReactNode;
}): ReactElement {
	return (
		<div className="empty" style={{ paddingTop: 40, paddingBottom: 40 }}>
			<span className="mk">
				<Icon className="ic ic-14" />
			</span>
			<span className="t">{title}</span>
			<span className="d">{description}</span>
			{action}
		</div>
	);
}
