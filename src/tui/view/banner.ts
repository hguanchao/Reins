import { swept } from "../render/sweep.ts";
import { displayWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 启动标志、版本号与一次性扫光。
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

/** 一帧的间隔：12fps 已经够平滑，首屏也不必为此连着重绘几十次。 */
export const BANNER_FRAME_MS = 83;
/** 从左侧外扫到右侧外的总时长。 */
export const BANNER_SWEEP_MS = 700;

/**
 * 启动画面的内容行。
 *
 * `shine` 是 0..1 的扫光进度，undefined 表示停在静止状态；标志与版本号都用 #16191d。
 * 光带整块共用一个相位，竖直地从左往右扫过，暗部与亮点跟运行时状态行共用同一套颜色。
 * 版本号不参与扫光：它只有一行，光带扫过去只会闪一下，反而打断整块标志的节奏。
 */
export function bannerLines(
	width: number,
	version: string,
	shine: number | undefined,
): readonly string[] {
	const columns = Math.max(0, width);
	const left = Math.max(0, Math.floor((columns - BLOCK_WIDTH) / 2));
	const lines: string[] = [];

	for (let row = 0; row < MARK.length; row += 1) {
		const art = padToWidth(MARK[row] ?? "", BLOCK_WIDTH);
		const colored =
			shine === undefined
				? `${THEME.textBanner}${art}${THEME.reset}`
				: swept(
						art,
						Math.min(1, Math.max(0, shine)),
						THEME.accentDim,
						THEME.sweepHighlight,
					);
		lines.push(`${" ".repeat(left)}${colored}`);
	}

	lines.push(...Array.from({ length: GAP }, () => ""));
	const label = `v${version}`;
	const labelLeft = left + Math.max(0, Math.floor((BLOCK_WIDTH - displayWidth(label)) / 2));
	lines.push(`${" ".repeat(labelLeft)}${THEME.textBanner}${label}${THEME.reset}`);
	return lines;
}

/** 右侧补空格到整块宽度：扫光按整块宽度算相位，各行的光带才会对齐。 */
function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
