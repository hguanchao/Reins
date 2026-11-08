import { ArrowUpRight, GitCompare, Play, Search } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

/** 起点建议：三条真实可点的动作，点一下就把这句话填进输入卡。 */
const STARTS: readonly { readonly icon: typeof Search; readonly text: string }[] = [
	{ icon: Search, text: "读懂这个项目：目录结构、技术栈与入口" },
	{ icon: Play, text: "跑一遍测试，把失败的修掉" },
	{ icon: GitCompare, text: "审阅当前未提交的改动" },
];

/**
 * 新建任务空态。
 *
 * 三层信息自上而下：这是什么（36px 标题 + 一行说明）、在哪干活（卡帽与输入卡）、能做什么
 * （三条起点建议）。整屏唯一的展示级排版在这里，所以标题之外不再有第二个大字号。
 * 设计稿的空态页固定不挂右面板，这里也不设面板开关。
 */
export function Hero({
	composer,
	onStart,
}: {
	readonly composer: ReactNode;
	onStart(text: string): void;
}): ReactElement {
	return (
		<div className="blank">
			<div className="blank-in">
				<div className="eyebrow" style={{ marginBottom: 14 }}>
					REINS · CODING AGENT
				</div>
				<h1>
					今天做什么？
					<span className="caret" />
				</h1>
				<p className="lede">Reins 是一款运行在终端与桌面的编码智能体。描述任务、审阅执行、合入成果。</p>

				{composer}

				<div className="starts">
					<div className="mono-label" style={{ marginBottom: 8, fontSize: 9 }}>
						从这里开始
					</div>
					{STARTS.map((entry) => {
						const Icon = entry.icon;
						return (
							<button key={entry.text} type="button" onClick={() => onStart(entry.text)}>
								<Icon className="ic ic-14" />
								<span className="grow">{entry.text}</span>
								<ArrowUpRight className="ic ic-12" />
							</button>
						);
					})}
				</div>

				<div className="keys">
					<span>Enter 发送</span>
					<span className="dot">·</span>
					<span>Shift Enter 换行</span>
					<span className="dot">·</span>
					<span>@ 引用文件</span>
					<span className="dot">·</span>
					<span>$ 调用技能</span>
				</div>
			</div>
		</div>
	);
}
