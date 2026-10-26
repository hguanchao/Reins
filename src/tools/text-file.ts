import { Buffer } from "node:buffer";

/**
 * 文本文件的字节与文本之间转换。
 *
 * 读取与修改都要处理同样两件事：编码与行尾。合并在一处是因为它们必须成对——读的时候怎么
 * 解释，写回的时候就得怎么还原，分开写迟早会对不上。
 *
 * 统一把正文里的换行归一为 LF：模型给出的片段几乎总是 LF，若不归一，一个 CRLF 的文件会让
 * 所有匹配都失败，而失败原因（「找不到这段文字」）完全指不到真正的问题上。写回时再按原文
 * 的行尾还原。
 */

type TextEncoding = "utf8" | "utf16le" | "utf16be";

export interface TextFile {
	/** 正文，已去掉字节顺序标记，换行统一为 LF */
	readonly text: string;
	readonly encoding: TextEncoding;
	readonly hasBom: boolean;
	readonly eol: "\n" | "\r\n";
	/**
	 * 解码时出现过非法字节序列。
	 *
	 * 这类文件（GBK、Shift-JIS 等非 UTF-8 编码）读进来就已经有字符被替换成 U+FFFD，再整份
	 * 编码写回会把原文彻底改坏。调用方据此拒绝写入，而不是悄悄毁掉使用者的文件。
	 */
	readonly lossy: boolean;
}

export function decodeTextFile(buffer: Buffer): TextFile {
	const decoded = decodeBytes(buffer);
	// 行尾要在解码之后判断：UTF-16 的字节里处处是零，按字节看会得出荒唐的结论
	const eol = decoded.text.includes("\r\n") ? "\r\n" : "\n";
	return {
		text: normalizeEol(decoded.text),
		encoding: decoded.encoding,
		hasBom: decoded.hasBom,
		eol,
		lossy: decoded.lossy,
	};
}

export function encodeTextFile(file: TextFile, text: string): Buffer {
	// 先把调用方给的换行统一成 LF 再还原：newText 可能自带 CRLF（从命令输出或另一个
	// Windows 文件里抄来的），直接 replaceAll 会把它变成 \r\r\n。
	const normalized = normalizeEol(text);
	const withEol = file.eol === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized;
	return encodeBytes(withEol, file.encoding, file.hasBom);
}

/** 把 CRLF 归一为 LF。单独的 CR 不动：它不是本项目的写入方式，改了反而动到不该动的内容。 */
function normalizeEol(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

interface DecodedBytes {
	readonly text: string;
	readonly encoding: TextEncoding;
	readonly hasBom: boolean;
	readonly lossy: boolean;
}

function decodeBytes(buffer: Buffer): DecodedBytes {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return {
			text: buffer.subarray(2).toString("utf16le"),
			encoding: "utf16le",
			hasBom: true,
			lossy: false,
		};
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		return {
			text: new TextDecoder("utf-16be").decode(buffer.subarray(2)),
			encoding: "utf16be",
			hasBom: true,
			lossy: false,
		};
	}

	// 用 fatal 解码试一次：非 UTF-8 编码（GBK、Shift-JIS 等）会抛错，据此标出「这份文件
	// 读进来就已经有损」，调用方据此拒绝回写。
	// BOM 由字节判断：TextDecoder 默认会把它从输出里去掉，靠字符串前缀判断会永远为假。
	const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		return { text: decoder.decode(buffer), encoding: "utf8", hasBom, lossy: false };
	} catch {
		// 解码失败时按替换字符显示：读取仍能进行，但这份内容不能原样写回。
		return { text: buffer.toString("utf8"), encoding: "utf8", hasBom, lossy: true };
	}
}

function encodeBytes(text: string, encoding: TextEncoding, hasBom: boolean): Buffer {
	switch (encoding) {
		case "utf16le": {
			const body = Buffer.from(text, "utf16le");
			return hasBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
		}
		case "utf16be": {
			const body = Buffer.from(text, "utf16le");
			body.swap16();
			return hasBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
		}
		default: {
			const body = Buffer.from(text, "utf8");
			return hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
		}
	}
}

/** 二进制探测读取文件开头的字节数:三个文件工具共用同一个判断口径。 */
export const BINARY_PROBE_BYTES = 8192;

/** 文件开头是否像二进制内容。文本文件在开头不会出现零字节，不必读全文。 */
export function looksBinary(buffer: Buffer, probeBytes: number): boolean {
	// UTF-16 正文的每个 ASCII 字符都带一个零字节；带 BOM 时它就是文本，不能按二进制拒绝。
	// 不带 BOM 的 UTF-16 无法与二进制可靠区分，仍按二进制处理。
	if (hasUtf16Bom(buffer)) return false;

	const limit = Math.min(buffer.length, probeBytes);
	for (let index = 0; index < limit; index += 1) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

function hasUtf16Bom(buffer: Buffer): boolean {
	return (
		buffer.length >= 2 &&
		((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
	);
}
