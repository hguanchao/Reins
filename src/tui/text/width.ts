/**
 * 终端里的显示宽度。
 *
 * 与字符串长度不是一回事：中日韩文字与全角标点占两列，变音符号等组合字符不占额外列。
 * 需要对齐的文本必须按显示宽度计算，否则中文标签的列会整体错位。
 *
 * 这里按码位判断，不处理字素簇：终端本身也大多按码位推进光标，而完整的字素切分是
 * 后续做换行与截断时才需要的能力。
 */

/** 占两列的区间。按码位从小到大排列，用二分查找。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f], // 谚文字母
	[0x2e80, 0x303e], // 中日韩部首、康熙部首、中日韩符号与标点
	[0x3041, 0x33ff], // 平假名、片假名、注音、中日韩兼容
	[0x3400, 0x4dbf], // 中日韩扩展 A
	[0x4e00, 0x9fff], // 中日韩统一表意文字
	[0xa000, 0xa4cf], // 彝文
	[0xac00, 0xd7a3], // 谚文音节
	[0xf900, 0xfaff], // 中日韩兼容表意文字
	[0xfe10, 0xfe19], // 竖排形式
	[0xfe30, 0xfe6f], // 中日韩兼容形式
	[0xff00, 0xff60], // 全角形式
	[0xffe0, 0xffe6], // 全角符号
	[0x1f300, 0x1f64f], // 表情符号
	[0x1f900, 0x1f9ff], // 补充符号
	[0x20000, 0x2fffd], // 中日韩扩展 B 及以后
	[0x30000, 0x3fffd],
];

/** 不占列的区间：组合用记号、零宽字符、变体选择符。 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
	[0x0300, 0x036f], // 组合用变音符号
	[0x200b, 0x200f], // 零宽空格、方向标记
	[0xfe00, 0xfe0f], // 变体选择符
	[0xfeff, 0xfeff], // 零宽不换行空格
];

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const [start, end] = ranges[middle];
		if (code < start) high = middle - 1;
		else if (code > end) low = middle + 1;
		else return true;
	}
	return false;
}

/** 单个码位占几列。 */
export function codePointWidth(code: number): number {
	if (code === 0) return 0;
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0; // 控制字符不推进光标
	if (code < 0x0300) return 1; // 拉丁文等，绝大多数文本走这条快路径
	if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
	if (code < 0x1100) return 1;
	if (inRanges(code, WIDE_RANGES)) return 2;
	return 1;
}

/** 字符串占多少列。 */
export function displayWidth(text: string): number {
	let total = 0;
	for (const char of text) total += codePointWidth(char.codePointAt(0) ?? 0);
	return total;
}
