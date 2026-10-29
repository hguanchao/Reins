import { displayWidth, truncateToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 启动标志与版本号。
 *
 * 标志用五行块字拼出 REINS：块字在等宽终端里不会像普通字标那样被字体差异拉宽，逐行
 * 对齐也稳定。整块按最宽的一行算宽度，短行右侧补空格——块字各行的尾端本来就不齐，
 * 按每行自己的宽度居中会让笔画整体错位。
 */

/** 五行块字；短行由 padToWidth 补齐到整块宽度。 */
const MARK: readonly string[] = [
	"████  █████  █████  █   █  █████",
	"█   █ █        █    ██  █  █",
	"████  ███      █    █ █ █  ████",
	"█  █  █        █    █  ██      █",
	"█   █ █████  █████  █   █  █████",
];

/** 标志与版本号之间的空行。 */
const GAP = 1;
/** 整块宽度；短行按它补齐。 */
const BLOCK_WIDTH = Math.max(...MARK.map((line) => displayWidth(line)));

/**
 * 启动画面的内容行。
 *
 * 标志与版本号都用弱文字色；版本号只有一行，单独居中在标志下方。
 */
export function bannerLines(width: number, version: string): readonly string[] {
	const columns = Math.max(0, width);
	// 窄终端放不下整块标志：按终端宽度截断，不能指望终端自动折行把版式兜住
	const left = columns >= BLOCK_WIDTH ? Math.max(0, Math.floor((columns - BLOCK_WIDTH) / 2)) : 0;
	const lines: string[] = [];

	for (const row of MARK) {
		const art = truncateToWidth(padToWidth(row, BLOCK_WIDTH), Math.max(0, columns - left));
		lines.push(`${" ".repeat(left)}${THEME.textSubtle}${art}${THEME.reset}`);
	}

	lines.push(...Array.from({ length: GAP }, () => ""));
	const label = `v${version}`;
	if (displayWidth(label) <= columns) {
		const labelLeft = Math.min(
			left + Math.max(0, Math.floor((BLOCK_WIDTH - displayWidth(label)) / 2)),
			Math.max(0, columns - displayWidth(label)),
		);
		lines.push(`${" ".repeat(labelLeft)}${THEME.textSubtle}${label}${THEME.reset}`);
	}
	return lines;
}

/** 右侧补空格到整块宽度：各行左缘对齐，整块才能稳定居中。 */
function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
