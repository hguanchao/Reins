/**
 * 配置文件问题的统一错误类型。
 *
 * 两个配置文件（TOML 与 JSON）的报错格式必须一致：使用者拿到的是「哪个文件的第几行第几列
 * 出了什么问题」，而不是各自一套说法。位置信息在解析阶段产生，文件路径在读取阶段补上，
 * 所以 file 是可选的。
 */
export class ConfigError extends Error {
	readonly file: string | undefined;
	/** 从 1 开始的行号；解析阶段无法定位时为 undefined */
	readonly line: number | undefined;
	/** 从 1 开始的列号 */
	readonly column: number | undefined;

	constructor(message: string, location?: { file?: string; line?: number; column?: number }) {
		super(message);
		this.name = "ConfigError";
		this.file = location?.file;
		this.line = location?.line;
		this.column = location?.column;
	}

	/** 补上文件路径。读取阶段捕获解析错误后调用，位置信息原样保留。 */
	withFile(file: string): ConfigError {
		return new ConfigError(this.message, { file, line: this.line, column: this.column });
	}

	/** 面向使用者的单行描述。 */
	get display(): string {
		const where = this.file === undefined ? "" : this.file;
		const at = this.line === undefined ? "" : `:${this.line}:${this.column ?? 1}`;
		return `${where}${at} ${this.message}`.trim();
	}
}

export interface LineColumn {
	/** 从 1 开始的行号 */
	readonly line: number;
	/** 从 1 开始的列号 */
	readonly column: number;
}

/** 把字符偏移换算成从 1 开始的行列号。 */
export function offsetToLineColumn(source: string, offset: number): LineColumn {
	let line = 1;
	let lineStart = 0;
	const limit = Math.min(offset, source.length);
	for (let index = 0; index < limit; index += 1) {
		if (source[index] === "\n") {
			line += 1;
			lineStart = index + 1;
		}
	}
	return { line, column: limit - lineStart + 1 };
}
