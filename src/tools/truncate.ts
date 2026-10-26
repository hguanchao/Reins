import { Buffer } from "node:buffer";

/**
 * 工具输出的截断。
 *
 * 模型看到的每一段输出都要有上限：一次读取或一条命令的输出轻易就能塞满整个上下文，而超出
 * 部分对判断没有帮助。截断按行边界进行，不留半行——半行会让模型以为内容就到这里了。
 */

export interface TruncateLimits {
	readonly maxLines: number;
	readonly maxBytes: number;
}

/** 读文件时的默认上限，与工具的说明文字保持一致。 */
export const DEFAULT_LIMITS: TruncateLimits = { maxLines: 2000, maxBytes: 50 * 1024 };

/** 单行匹配结果的显示上限。整行几万字符的压缩文件会把结果撑爆。 */
export const MAX_LINE_LENGTH = 500;

export interface TruncatedText {
	readonly text: string;
	readonly truncated: boolean;
	/** 保留区间的首行与末行行号，均从 1 开始 */
	readonly startLine: number;
	readonly endLine: number;
	/** 原文总行数 */
	readonly totalLines: number;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** 把文本切成行，末尾的换行不产生额外空行。 */
export function splitLines(text: string): readonly string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	// 以换行结尾的文件按 TOML 之外的习惯仍算 N 行，最后那个空串不代表一行
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * 从开头保留。
 *
 * 单行本身就超过字节上限时只保留这一行的前一段并标记截断：此时没有「行边界」可用，
 * 保留半行好过返回空结果，模型至少知道有这一行存在。
 */
export function truncateHead(text: string, limits: TruncateLimits): TruncatedText {
	const lines = splitLines(text);
	const kept: string[] = [];
	let bytes = 0;
	let truncated = false;

	for (let index = 0; index < lines.length; index += 1) {
		if (kept.length >= limits.maxLines) {
			truncated = true;
			break;
		}
		const line = lines[index];
		const size = byteLength(line) + 1;
		if (bytes + size > limits.maxBytes) {
			truncated = true;
			if (kept.length === 0) {
				kept.push(limitLineBytes(line, limits.maxBytes));
			}
			break;
		}
		kept.push(line);
		bytes += size;
	}

	return {
		text: kept.join("\n"),
		truncated: truncated || kept.length < lines.length,
		startLine: 1,
		endLine: kept.length,
		totalLines: lines.length,
	};
}

/**
 * 从结尾保留。命令输出通常是「过程很长、结论在最后」。
 *
 * 最后一行本身就超上限时，保留它的尾部并标记截断。这里与 truncateHead 对称：返回空文本
 * 会让模型以为命令没有任何输出，而它明明输出了几十 KB。
 */
export function truncateTail(text: string, limits: TruncateLimits): TruncatedText {
	const lines = splitLines(text);
	const kept: string[] = [];
	let bytes = 0;
	let firstKept = lines.length;
	/** 最后一行本身超上限、被切成了尾部一段 */
	let lineCut = false;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (kept.length >= limits.maxLines) break;
		const line = lines[index];
		const size = byteLength(line) + 1;
		if (bytes + size > limits.maxBytes) {
			if (kept.length === 0) {
				const tail = tailLineBytes(line, limits.maxBytes);
				lineCut = tail.length < line.length;
				kept.unshift(tail);
				firstKept = index;
			}
			break;
		}
		kept.unshift(line);
		firstKept = index;
		bytes += size;
	}

	return {
		text: kept.join("\n"),
		truncated: lineCut || firstKept > 0 || kept.length < lines.length,
		startLine: firstKept + 1,
		endLine: lines.length,
		totalLines: lines.length,
	};
}

/** 按字节上限切一行，切点落在字符边界上。 */
export function limitLineBytes(line: string, maxBytes: number): string {
	if (byteLength(line) <= maxBytes) return line;
	// 从字符数上限开始收缩，避免把多字节字符切成半个
	let end = Math.min(line.length, maxBytes);
	while (end > 0 && byteLength(line.slice(0, end)) > maxBytes) end -= 1;
	// 收缩后若停在代理对中间，再退一格：孤立代理项写到终端会变成替换字符
	if (end > 0 && end < line.length && isHighSurrogate(line.charCodeAt(end - 1))) end -= 1;
	return line.slice(0, end);
}

/** 从尾部按字节上限切一行，切点同样落在字符边界上。 */
export function tailLineBytes(line: string, maxBytes: number): string {
	if (byteLength(line) <= maxBytes) return line;
	let start = Math.max(0, line.length - maxBytes);
	while (start < line.length && byteLength(line.slice(start)) > maxBytes) start += 1;
	// 起点落在低代理项上时前进一格，避免留下孤立代理项
	if (start < line.length && isLowSurrogate(line.charCodeAt(start))) start += 1;
	return line.slice(start);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** 单行显示截断：超长行只留前一段，并注明原长。 */
export function truncateLine(line: string, maxLength: number = MAX_LINE_LENGTH): string {
	if (line.length <= maxLength) return line;
	return `${line.slice(0, maxLength)}… (the line is ${line.length} characters long)`;
}
