/**
 * 两个隔离后端共用的 shell 引用。
 *
 * 单引号包裹、内部单引号先闭合再转义,是 POSIX shell 唯一可靠的引用方式;
 * 后端各写一份迟早有一个改漏。
 */

/** 包成单引号字面量:内部的单引号先闭合、转义再重开。 */
export function quoteForShell(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
