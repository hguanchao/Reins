/**
 * turndown 与 GFM 插件的最小类型替身。
 *
 * 两个包都不自带类型声明，@types/turndown 又引用 DOM lib；本项目只用「实例化、装插件、
 * 加规则、转字符串」这一条路径，因此只声明用到的表面。传入 turndown 的 DOM 节点来自
 * domino（其类型同样是最小替身），所以这里收 unknown。
 */

declare module "turndown" {
	export interface TurndownOptions {
		headingStyle?: "setext" | "atx";
		codeBlockStyle?: "indented" | "fenced";
		bulletListMarker?: "-" | "+" | "*";
	}

	class TurndownService {
		constructor(options?: TurndownOptions);
		/** 装载插件；插件自身没有类型，按 unknown 传递 */
		use(plugin: unknown): this;
		addRule(key: string, rule: unknown): this;
		turndown(input: unknown): string;
	}

	export default TurndownService;
}

declare module "@joplin/turndown-plugin-gfm" {
	/** 插件本体是给 turndown.use 用的函数；turndown 一侧收 unknown，这里不再描述形状。 */
	export const gfm: unknown;
}
