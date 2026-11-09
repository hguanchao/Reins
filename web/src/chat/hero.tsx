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
 * 顶部是居中的品牌头（标识、名称、定位、一行说明），下面只留卡帽、输入卡与三条
 * 可点的起点建议。设计稿的空态页固定不挂右面板，这里也不设面板开关。
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
				<div className="hero-head">
					<div className="hero-brand">
						<span className="brandmark" aria-hidden="true" />
						<span className="hero-name">Reins</span>
					</div>
					<div className="eyebrow">CODING AGENT HARNESS</div>
					<p className="lede">Reins 是一款运行在终端与桌面的编码智能体。描述任务、审阅执行、合入成果。</p>
				</div>

				{composer}

				<div className="starts">
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
			</div>
		</div>
	);
}
