import { eastAsianWidth } from "get-east-asian-width";

/**
 * 终端里的显示宽度。
 *
 * 与字符串长度不是一回事：中日韩文字与全角标点占两列，组合用记号不占额外列。需要对齐的
 * 文本必须按显示宽度算，否则中文标签的列会整体错位。
 *
 * 占几列由 Unicode 的东亚长度属性决定，这份属性表庞大且随 Unicode 版本更新，自己维护必然
 * 滞后，所以交给专门的包；这里只补两件它不管的事：控制字符不推进光标，组合用记号不占列。
 * 属性值为「歧义」的字符按窄处理——规范建议在无法确定上下文时按窄处理，这样在非中日韩
 * 环境下也不会多留出空格。
 *
 * 按码位判断，不处理字素簇：终端本身也大多按码位推进光标，完整的字素切分是后续做换行与
 * 截断时才需要的能力。
 */

/** 不占列的码位区间：组合用记号、零宽字符、变体选择符。 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
	[0x0300, 0x036f], // 组合用变音符号
	[0x200b, 0x200f], // 零宽空格、方向标记
	[0xfe00, 0xfe0f], // 变体选择符
	[0xfeff, 0xfeff], // 零宽不换行空格
];

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
	for (const [start, end] of ranges) {
		if (code >= start && code <= end) return true;
	}
	return false;
}

/** 单个码位占几列。 */
export function codePointWidth(code: number): number {
	if (code === 0) return 0;
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0; // 控制字符不推进光标
	if (code < 0x0300) return 1; // 拉丁文等，绝大多数文本走这条快路径
	if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
	return eastAsianWidth(code);
}

/** 字符串占多少列。 */
export function displayWidth(text: string): number {
	let total = 0;
	for (const char of text) total += codePointWidth(char.codePointAt(0) ?? 0);
	return total;
}
