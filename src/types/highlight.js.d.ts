/**
 * highlight.js 的最小类型替身。
 *
 * 该包自带的类型入口带 `/// <reference lib="dom" />`，会让整个工程获得浏览器全局类型，
 * 连全局 fetch 的 RequestInit 都会被换成 DOM 版本——Node 独有的 dispatcher 就此消失。
 * 本项目只用到「语言定义函数」这一种导出，因此在这里给出最小声明，并在 tsconfig 的
 * paths 里把 highlight.js 的类型解析指过来。
 */

declare module "highlight.js" {
	export type LanguageFn = (hljs: unknown) => unknown;

	const hljs: unknown;
	export default hljs;
}

declare module "highlight.js/lib/languages/*" {
	import type { LanguageFn } from "highlight.js";

	const language: LanguageFn;
	export default language;
}
