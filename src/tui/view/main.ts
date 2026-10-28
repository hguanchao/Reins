import { bannerLines } from "./banner.ts";

/**
 * 主区域启动画面。
 *
 * 对话开始前显示标志与版本号；对话开始后由 transcript 接管主区域。
 */

/**
 * 标志、版本号整体在给定区域内居中。
 *
 * 返回的行数恰好等于 height，空行也一并返回，调用方按顺序逐行写出即可。主区域放不下
 * 整块时先去掉标志与版本号之间的空行：版本号比留白重要。终端比标志还窄时不做截断：
 * 截断会把标志切掉一半，宁可让它超出边界。
 */
export function renderMain(
	width: number,
	height: number,
	version: string,
	shine?: number,
): readonly string[] {
	const content = bannerLines(width, version, shine);
	const fitted = content.length > height ? content.filter((line) => line !== "") : content;
	const lines: string[] = Array.from({ length: Math.max(0, height) }, () => "");
	const top = Math.max(0, Math.floor((lines.length - fitted.length) / 2));

	for (let index = 0; index < fitted.length; index += 1) {
		const row = top + index;
		if (row >= lines.length) break;
		lines[row] = fitted[index] ?? "";
	}

	return lines;
}
