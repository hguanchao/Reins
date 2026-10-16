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

export type TextEncoding = "utf8" | "utf16le" | "utf16be";

export interface TextFile {
	/** 正文，已去掉字节顺序标记，换行统一为 LF */
	readonly text: string;
	readonly encoding: TextEncoding;
	readonly hasBom: boolean;
	readonly eol: "\n" | "\r\n";
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
	};
}

export function encodeTextFile(file: TextFile, text: string): Buffer {
	const withEol = file.eol === "\r\n" ? text.replaceAll("\n", "\r\n") : text;
	return encodeBytes(withEol, file.encoding, file.hasBom);
}

/** 把 CRLF 归一为 LF。单独的 CR 不动：它不是本项目的写入方式，改了反而动到不该动的内容。 */
export function normalizeEol(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

interface DecodedBytes {
	readonly text: string;
	readonly encoding: TextEncoding;
	readonly hasBom: boolean;
}

function decodeBytes(buffer: Buffer): DecodedBytes {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf16le", hasBom: true };
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		return {
			text: new TextDecoder("utf-16be").decode(buffer.subarray(2)),
			encoding: "utf16be",
			hasBom: true,
		};
	}
	const text = buffer.toString("utf8");
	if (text.startsWith("\uFEFF")) {
		return { text: text.slice(1), encoding: "utf8", hasBom: true };
	}
	return { text, encoding: "utf8", hasBom: false };
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

/** 文件开头是否像二进制内容。文本文件在开头不会出现零字节，不必读全文。 */
export function looksBinary(buffer: Buffer, probeBytes: number): boolean {
	const limit = Math.min(buffer.length, probeBytes);
	for (let index = 0; index < limit; index += 1) {
		if (buffer[index] === 0) return true;
	}
	return false;
}
