import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 大结果落盘。
 *
 * 工具结果超过阈值时整段写入临时文件，上下文里只留一段预览与文件路径。让模型直接吞下几万
 * 字符既贵又没用——它读不完；直接丢掉更不行，结论可能就藏在里面。落盘之后它需要时可以按
 * 行自己读取。
 */

/** 溢出尾注的固定前缀:界面的折叠行靠它识别「这条结果被截断过」。 */
const SPILL_FOOTER_PREFIX = "[the full result is ";

/** 工具尾注的通用形态:空一行后接一个方括号开头的说明。各工具尾注都在这条规则之下。 */
const FOOTER_MARK = "\n\n[";

/**
 * 剥掉结果尾注,返回纯预览正文。
 *
 * 尾注是工具与界面之间的文本契约(溢出路径、读取行区间、搜索命中上限都以方括号尾注交付),
 * 剥法只写这一份:按「空一行 + 方括号」切断,前缀常量供逐工具精确判定。
 *
 * 只在最后一个「空行 + 方括号」处切断：正文里自带 `\n\n[` 的情况很常见（Markdown 链接、
 * 脚注、数组字面量），从第一个位置切会把大半内容丢掉。
 */
export function stripSpillFooter(content: string): string {
	const index = content.lastIndexOf(FOOTER_MARK);
	if (index <= 0) return content.replace(/\n$/, "");
	// 切断点之后必须像一条尾注：以 `[` 开头、且这一段不含空行
	const footer = content.slice(index + FOOTER_MARK.length);
	if (footer.includes("\n\n")) return content.replace(/\n$/, "");
	return (content.slice(0, index) || content).replace(/\n$/, "");
}

/** 结果是否带溢出尾注。 */
export function hasSpillFooter(content: string): boolean {
	return content.includes(`\n\n${SPILL_FOOTER_PREFIX}`);
}
export class ResultSpiller {
	#threshold: number;
	readonly #directory: string;
	#counter = 0;

	constructor(threshold: number, directory: string) {
		this.#threshold = threshold;
		this.#directory = directory;
	}

	/** 配置热更新时换阈值；之后的工具结果按新值判断，已经落盘的不受影响。 */
	setThreshold(threshold: number): void {
		this.#threshold = threshold;
	}

	/** 未超过阈值就原样返回。 */
	spill(toolName: string, content: string): string {
		if (this.#threshold <= 0 || content.length <= this.#threshold) return content;

		const path = this.#write(toolName, content);
		const preview = this.#preview(content);
		if (path === undefined) {
			// 落盘失败必须说出来：只给一段被截断的内容，模型会以为这就是全部
			return `${preview}\n\n${SPILL_FOOTER_PREFIX}${content.length} characters; writing the spill file failed, so the rest cannot be retrieved]`;
		}
		return `${preview}\n\n${SPILL_FOOTER_PREFIX}${content.length} characters; written to ${path}, read it back line by line]`;
	}

	#preview(content: string): string {
		// 头尾各留一半：命令输出常常开头是过程、结尾是结论，中间才是最不重要的部分。
		// 切点按码位算：按 UTF-16 码元切会把 emoji 之类的代理对劈开，预览里出现半个字符。
		const chars = Array.from(content);
		const head = Math.floor(this.#threshold / 2);
		const tail = this.#threshold - head;
		const omitted = Math.max(0, chars.length - head - tail);
		const headText = chars.slice(0, head).join("");
		const tailText = chars.slice(chars.length - tail).join("");
		return `${headText}\n\n… (${omitted} characters omitted in the middle) …\n\n${tailText}`;
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
			// 目录与文件只给当前用户：落盘内容可能含工作区外的密钥或命令环境输出
			mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
			writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
			return path;
		} catch {
			return undefined;
		}
	}
}
