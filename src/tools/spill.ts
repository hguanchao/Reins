import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 大结果落盘。
 *
 * 工具结果超过阈值时整段写入临时文件，上下文里只留一段预览与文件路径。让模型直接吞下几万
 * 字符既贵又没用——它读不完；直接丢掉更不行，结论可能就藏在里面。落盘之后它需要时可以按
 * 行自己读取。
 */
export class ResultSpiller {
	readonly #threshold: number;
	readonly #directory: string;
	#counter = 0;

	constructor(threshold: number, directory: string) {
		this.#threshold = threshold;
		this.#directory = directory;
	}

	/** 未超过阈值就原样返回。 */
	spill(toolName: string, content: string): string {
		if (this.#threshold <= 0 || content.length <= this.#threshold) return content;

		const path = this.#write(toolName, content);
		const preview = this.#preview(content);
		if (path === undefined) {
			// 落盘失败必须说出来：只给一段被截断的内容，模型会以为这就是全部
			return `${preview}\n\n[the full result is ${content.length} characters; writing the spill file failed, so the rest cannot be retrieved]`;
		}
		return `${preview}\n\n[the full result is ${content.length} characters; written to ${path}, read it back line by line]`;
	}

	#preview(content: string): string {
		// 头尾各留一半：命令输出常常开头是过程、结尾是结论，中间才是最不重要的部分
		const head = Math.floor(this.#threshold / 2);
		const tail = this.#threshold - head;
		const omitted = content.length - head - tail;
		return `${content.slice(0, head)}\n\n… (${omitted} characters omitted in the middle) …\n\n${content.slice(content.length - tail)}`;
	}

	#write(toolName: string, content: string): string | undefined {
		const safeName = toolName.replaceAll(/[^\w-]/g, "_");
		this.#counter += 1;
		// 文件名带进程号:两个进程在同一毫秒落盘也不会互相覆盖
		const path = join(
			this.#directory,
			`reins-${safeName}-${process.pid}-${Date.now()}-${this.#counter}.log`,
		);
		try {
			mkdirSync(this.#directory, { recursive: true });
			writeFileSync(path, content, "utf8");
			return path;
		} catch {
			return undefined;
		}
	}
}
