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
 * 按字素簇而不是码位计量：一个 emoji 常常由多个码位组成（肤色修饰符、零宽连接符拼接的
 * 家庭、带变体选择符的字符），逐码位相加会把它们算成好几列，而对齐的大括号分列全都会歪掉。
 * 字素簇的切分交给 Intl.Segmenter，它随 Node 一起提供，不必自己维护一张表。
 */

/** 不占列的码位区间：组合用记号、零宽字符、变体选择符。 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
	[0x0300, 0x036f], // 组合用变音符号
	[0x200b, 0x200f], // 零宽空格、方向标记
	[0xfe00, 0xfe0f], // 变体选择符
	[0xfeff, 0xfeff], // 零宽不换行空格
];

const EMOTICON_MODIFIER_START = 0x1f3fb;
const EMOTICON_MODIFIER_END = 0x1f3ff;
const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;

const ZWJ = 0x200d;
const VARIATION_SELECTOR_16 = 0xfe0f; // 要求按 emoji 呈现
const VARIATION_SELECTOR_15 = 0xfe0e; // 要求按文字呈现
const COMBINING_ENCLOSING_KEYCAP = 0x20e3;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
	for (const [start, end] of ranges) {
		if (code >= start && code <= end) return true;
	}
	return false;
}

/** 单个码位占几列。只用于字素簇内部累加，一般不直接对整串调用。 */
export function codePointWidth(code: number): number {
	if (code === 0) return 0;
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0; // 控制字符不推进光标
	if (code < 0x0300) return 1; // 拉丁文等，绝大多数文本走这条快路径
	if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
	return eastAsianWidth(code);
}

/**
 * 一个字的整簇占几列。
 *
 * 簇里出现 emoji 专用记号时整簇按一个 emoji 算两列：这一类记号的语义就是「把前面的字符
 * 变成合成图形」，逐个码位相加必然偏大。
 */
export function graphemeWidth(cluster: string): number {
	const codes = [...cluster].map((char) => char.codePointAt(0) ?? 0);
	const baseWidth = codePointWidth(codes[0] ?? 0);

	// 没有基字符可修饰（孤立的选择符、零宽字符），按各码位之和算，通常就是零
	if (baseWidth === 0) {
		let total = 0;
		for (const code of codes) total += codePointWidth(code);
		return total;
	}

	for (const code of codes) {
		// 明确要求按文字呈现时，整簇退回到基字符的宽度
		if (code === VARIATION_SELECTOR_15) return baseWidth;
		if (
			code === ZWJ ||
			code === VARIATION_SELECTOR_16 ||
			code === COMBINING_ENCLOSING_KEYCAP ||
			(code >= EMOTICON_MODIFIER_START && code <= EMOTICON_MODIFIER_END) ||
			(code >= REGIONAL_INDICATOR_START && code <= REGIONAL_INDICATOR_END)
		) {
			return 2;
		}
	}

	let total = baseWidth;
	for (const code of codes.slice(1)) total += codePointWidth(code);
	return total;
}

/** 按字素簇切分，供换行与截断逐簇处理。 */
export function segmentGraphemes(text: string): readonly string[] {
	const clusters: string[] = [];
	for (const { segment } of segmenter.segment(text)) clusters.push(segment);
	return clusters;
}

/** 字符串占多少列。 */
export function displayWidth(text: string): number {
	let total = 0;
	for (const cluster of segmentGraphemes(text)) total += graphemeWidth(cluster);
	return total;
}
