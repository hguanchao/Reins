/**
 * 代码语法高亮。
 *
 * 一次调用要对整段代码着色再拆回各行：块注释、模板字符串这类跨行结构只有整段解析才能
 * 判断正确，逐行调用会把每一行都当成独立语句，后半段颜色就错了。
 *
 * 语言靠文件扩展名推断——编辑器知道自己在编辑什么文件，这是最可靠的线索；认不出的扩展名
 * 就不着色，宁可整段用正文色，也不能拿错误的语法去猜。
 */

import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** 语法 token 的角色，与调色板一一对应；渲染层只认角色，不认第三方类名。 */
export type SyntaxToken = "keyword" | "string" | "number" | "comment" | "function" | "type" | "operator";

/** 一段同样式文本。 */
export interface SyntaxSegment {
	readonly text: string;
	/** 无角色表示普通正文 */
	readonly token?: SyntaxToken;
}

/** 高亮解析出的单行内容；行数与传入的代码行一一对应。 */
export type SyntaxLines = readonly (readonly SyntaxSegment[])[];

/**
 * 按扩展名装载语言。
 *
 * 只登记这些语言：判定标准是「日常改代码会碰到」，而不是把 highlight.js 支持的全集塞进来。
 * 全集会让进程启动多背几兆，而用不上的语言一次也不会被解析。
 */
const LANGUAGES = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	go,
	ini,
	java,
	javascript,
	json,
	kotlin,
	lua,
	makefile,
	markdown,
	php,
	python,
	ruby,
	rust,
	sql,
	swift,
	typescript,
	xml,
	yaml,
} as const;

type LanguageName = keyof typeof LANGUAGES;

/** 扩展名到语言名；同名语言的多个写法都要认，否则 `.mts` 这类会被漏掉。 */
const EXTENSIONS: Readonly<Record<string, LanguageName>> = {
	bash: "bash",
	c: "c",
	cc: "cpp",
	cjs: "javascript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	cxx: "cpp",
	diff: "diff",
	dockerfile: "dockerfile",
	go: "go",
	h: "c",
	hpp: "cpp",
	htm: "xml",
	html: "xml",
	ini: "ini",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "javascript",
	kt: "kotlin",
	kts: "kotlin",
	lua: "lua",
	makefile: "makefile",
	markdown: "markdown",
	md: "markdown",
	mjs: "javascript",
	mk: "makefile",
	mts: "typescript",
	php: "php",
	properties: "ini",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	sql: "sql",
	swift: "swift",
	toml: "ini",
	ts: "typescript",
	tsx: "typescript",
	vue: "xml",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

/** 没有扩展名但文件名本身就是语言标识的。 */
const FILENAMES: Readonly<Record<string, LanguageName>> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
};

const highlighter = createLowlight(LANGUAGES);

/**
 * 推断文件使用的语言；认不出时返回 undefined，调用方据此跳过着色。
 *
 * 只看文件名，不读内容也不做嗅探：内容嗅探在代码片段上很容易误判，误判的着色比不着色更难读。
 */
export function languageForPath(path: string): LanguageName | undefined {
	const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
	if (name.length === 0) return undefined;

	const byName = FILENAMES[name];
	if (byName !== undefined) return byName;

	const dot = name.lastIndexOf(".");
	// 以点开头且没有第二个点的是隐藏文件，不是扩展名
	if (dot <= 0 || dot === name.length - 1) return undefined;
	return EXTENSIONS[name.slice(dot + 1)];
}

/**
 * 高亮一段代码，按行返回。
 *
 * 传入的每一行必须与结果一一对应：调用方仍按自己掌握的行号与增删标记排版，这里只负责上色，
 * 不能因为某个片段为空就丢行。
 */
export function highlightCode(code: string, path: string): SyntaxLines | undefined {
	const language = languageForPath(path);
	if (language === undefined) return undefined;

	const key = `${language}\u0000${code}`;
	const cached = CACHE.get(key);
	if (cached !== undefined) return cached;

	const lines = parse(code, language);
	if (lines !== undefined) remember(key, lines);
	return lines;
}

function parse(code: string, language: LanguageName): SyntaxLines | undefined {
	let tree;
	try {
		tree = highlighter.highlight(language, code);
	} catch {
		// 语法定义自身出错时整段退回纯文本，界面不能因为着色失败就少几行
		return undefined;
	}

	const lines: SyntaxSegment[][] = [[]];
	const append = (text: string, token: SyntaxToken | undefined): void => {
		const parts = text.split("\n");
		for (const [index, part] of parts.entries()) {
			if (index > 0) lines.push([]);
			if (part.length > 0) pushSegment(lines[lines.length - 1] ?? [], part, token);
		}
	};

	const walk = (node: unknown, token: SyntaxToken | undefined): void => {
		if (typeof node !== "object" || node === null) return;
		const typed = node as {
			readonly type?: unknown;
			readonly value?: unknown;
			readonly tagName?: unknown;
			readonly properties?: { readonly className?: readonly unknown[] };
			readonly children?: readonly unknown[];
		};

		if (typed.type === "text" && typeof typed.value === "string") {
			append(typed.value, token);
			return;
		}
		const next = tokenFor(typed.properties?.className) ?? token;
		for (const child of typed.children ?? []) walk(child, next);
	};

	for (const child of tree.children ?? []) walk(child, undefined);
	return lines;
}

/**
 * 同一次会话里同一段代码会被反复重绘（滚动、调整窗口、流式输出都会触发），因此记住结果。
 * 上限按「屏幕上同时展开的 diff 数量」取，超出后丢最早的一条，不做访问计数。
 */
const CACHE_LIMIT = 32;
const CACHE = new Map<string, SyntaxLines>();

function remember(key: string, lines: SyntaxLines): void {
	if (CACHE.size >= CACHE_LIMIT) {
		const oldest = CACHE.keys().next();
		if (oldest.done !== true) CACHE.delete(oldest.value);
	}
	CACHE.set(key, lines);
}

/** 相邻同样式片段合并，减少输出里的转义序列数量。 */
function pushSegment(line: SyntaxSegment[], text: string, token: SyntaxToken | undefined): void {
	const last = line.at(-1);
	if (last !== undefined && last.token === token) {
		line[line.length - 1] = { text: last.text + text, token };
		return;
	}
	line.push(token === undefined ? { text } : { text, token });
}

/** highlight.js 的类名到角色：只认需要的几类，其余按普通正文处理。 */
function tokenFor(className: readonly unknown[] | undefined): SyntaxToken | undefined {
	if (className === undefined) return undefined;

	for (const entry of className) {
		if (typeof entry !== "string") continue;
		// 类名形如 hljs-title function_，前缀决定大类，后缀只用于细分
		if (entry === "hljs-keyword" || entry === "hljs-literal" || entry === "hljs-built_in") return "keyword";
		if (entry === "hljs-string" || entry === "hljs-regexp" || entry === "hljs-char") return "string";
		if (entry === "hljs-number") return "number";
		if (entry === "hljs-comment" || entry === "hljs-quote") return "comment";
		if (entry === "hljs-title") return "function";
		if (entry === "hljs-type" || entry === "hljs-class") return "type";
		if (entry === "hljs-attr" || entry === "hljs-attribute" || entry === "hljs-variable") return "operator";
	}
	return undefined;
}
