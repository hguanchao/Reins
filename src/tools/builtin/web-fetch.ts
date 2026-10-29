import { describeError } from "../../shared/describe-error.ts";
import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import {
	DEFAULT_WEB_FETCH_LIMITS,
	fetchWebPage,
	formatFetchedPage,
} from "../web-fetch.ts";

/**
 * 抓取网页。
 *
 * 公网 http(s) 资源是模型补充「仓库之外的事实」(文档、issue、发布说明)的常规入口。
 * 安全边界全部在引擎里：只放公网地址、同源内跟重定向、拒收二进制——这里只负责把结果
 * 拼成模型可读的正文，以及给出按站点记忆的审批范围。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		url: { type: "string", description: "Absolute http(s) URL to fetch." },
	},
	required: ["url"],
} as const satisfies JsonSchema;

type WebFetchArgs = {
	readonly url: string;
};

/** 从原始输入里解出主机名，解不出就返回 undefined。 */
export function hostOf(rawUrl: string): string | undefined {
	try {
		const url = new URL(rawUrl);
		return url.hostname.length === 0 ? undefined : url.hostname;
	} catch {
		return undefined;
	}
}

export const webFetchTool: ToolDefinition<WebFetchArgs> = {
	name: "web_fetch",
	summary: "Fetch a public web page and return it as markdown",
	description:
		"Fetch an http(s) URL and return the page as markdown (raw text for JSON/XML/plain responses). " +
		"Only public internet addresses are fetchable: loopback, private and link-local hosts are refused, " +
		"and redirects are followed only within the same origin, so a cross-origin redirect is reported " +
		"back with its target instead of being followed. Binary content is rejected. " +
		"Responses are capped (20 s timeout, at most 5 redirects, 5 MB body) and truncation is reported. " +
		"Use this to read documentation, issue threads and release notes; there is no search, " +
		"so the URL must be known beforehand.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: true },

	// 按站点记忆「本会话总是允许」：一次批准覆盖同一主机的后续抓取，换主机再问
	permissionScope(args) {
		const host = hostOf(args.url);
		if (host === undefined) return undefined;
		return {
			key: `web_fetch:${host}`,
			label: `Fetch web pages from ${host}`,
			short: `fetch ${host}`,
		};
	},

	async execute({ args, signal }): Promise<ToolResult> {
		try {
			const page = await fetchWebPage(args.url, DEFAULT_WEB_FETCH_LIMITS, { signal });
			return {
				content: formatFetchedPage(page, DEFAULT_WEB_FETCH_LIMITS),
				details: { url: page.url, statusCode: page.statusCode, truncated: page.truncatedByBytes || page.truncatedByChars },
			};
		} catch (error) {
			return { content: `Not fetched: ${describeError(error)}`, isError: true };
		}
	},
};
