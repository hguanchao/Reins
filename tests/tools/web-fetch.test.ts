import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
	DEFAULT_WEB_FETCH_LIMITS,
	classifyContentType,
	fetchWebPage,
	formatFetchedPage,
	htmlToMarkdown,
	isPublicAddress,
	validateFetchUrl,
	type WebFetchLimits,
} from "../../src/tools/web-fetch.ts";

/** 测试里允许连到 127.0.0.1 的本地服务；生产路径默认策略的拒绝行为由单独用例覆盖。 */
const LOOPBACK_FETCH = { addressFilter: () => true, signal: AbortSignal.timeout(10_000) } as const;

/** 起一个按路径应答的本地服务；路由在用例内通过闭包扩展。 */
function startServer(handler: (route: string, response: import("node:http").ServerResponse) => void): Promise<Server> {
	const server = createServer((request, response) => {
		handler(new URL(request.url ?? "/", "http://localhost").pathname, response);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function portOf(server: Server): number {
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return address.port;
}

describe("URL 策略", () => {
	it("接受 http(s) 地址并保留查询串", () => {
		const url = validateFetchUrl("https://example.com/docs/a?b=1");
		assert.equal(url.hostname, "example.com");
	});

	it("拒绝非 http(s)、带凭据、超长与无法解析的输入", () => {
		assert.throws(() => validateFetchUrl("ftp://example.com/file"), /only http and https/);
		assert.throws(() => validateFetchUrl("https://user:pass@example.com/"), /credentials/);
		assert.throws(() => validateFetchUrl(`https://example.com/${"a".repeat(2100)}`), /maximum length/);
		assert.throws(() => validateFetchUrl("not a url"), /invalid URL/);
	});
});

describe("公网地址判定", () => {
	it("放行公网地址", () => {
		for (const address of ["8.8.8.8", "1.0.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
			assert.equal(isPublicAddress(address), true, address);
		}
	});

	it("拒绝私网、环回、链路本地、保留段与过渡技术", () => {
		for (const address of [
			"0.0.0.0",
			"10.1.2.3",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.1.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"192.0.0.1",
			"192.0.2.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"240.0.0.1",
			"::",
			"::1",
			"0:0:0:0:0:0:0:1",
			"::ffff:127.0.0.1",
			"fe80::1",
			"fec0::1",
			"fc00::1",
			"fd12::1",
			"ff02::1",
			"100::1",
			"2001::",
			"2001:0::1",
			"2001:db8::1",
			"2002::8.8.8.8",
			"64:ff9b::8.8.8.8",
		]) {
			assert.equal(isPublicAddress(address), false, address);
		}
	});
});

describe("Content-Type 分类", () => {
	it("html/xhtml 归为 html", () => {
		assert.equal(classifyContentType("text/html; charset=utf-8"), "html");
		assert.equal(classifyContentType("application/xhtml+xml"), "html");
	});

	it("文本与结构化文本归为 text", () => {
		assert.equal(classifyContentType("text/plain"), "text");
		assert.equal(classifyContentType("application/json"), "text");
		assert.equal(classifyContentType("application/ld+json"), "text");
		assert.equal(classifyContentType("application/xml"), "text");
	});

	it("二进制与缺失声明拒收", () => {
		assert.equal(classifyContentType("image/png"), undefined);
		assert.equal(classifyContentType("application/octet-stream"), undefined);
		assert.equal(classifyContentType(null), undefined);
	});
});

describe("HTML 转 markdown", () => {
	it("产出标题、强调与表格，剥掉脚本", () => {
		const markdown = htmlToMarkdown(
			"<html><body><h1>Title</h1><script>evil()</script>" +
				"<table><tr><th>a</th><td>1</td></tr></table><p>Some <b>bold</b> text</p></body></html>",
		);
		assert.ok(markdown.includes("# Title"));
		assert.ok(markdown.includes("**bold**"));
		assert.ok(markdown.includes("| a   | 1   |"));
		assert.equal(markdown.includes("evil"), false);
	});

	it("空正文返回空串", () => {
		assert.equal(htmlToMarkdown("<html><body></body></html>"), "");
	});
});

describe("抓取引擎（本地服务）", () => {
	let server: Server;
	let base: string;

	before(async () => {
		server = await startServer((route, response) => {
			switch (route) {
				case "/html":
					response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
					response.end("<html><body><h1>Hello</h1><script>evil()</script><p>world</p></body></html>");
					return;
				case "/latin1":
					response.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
					response.end(Buffer.from("<p>caf\xe9</p>", "latin1"));
					return;
				case "/text":
					response.writeHead(200, { "content-type": "text/plain" });
					response.end("plain body");
					return;
				case "/json":
					response.writeHead(200, { "content-type": "application/json" });
					response.end('{"ok":1}');
					return;
				case "/binary":
					response.writeHead(200, { "content-type": "image/png" });
					response.end("xx");
					return;
				case "/redirect":
					response.writeHead(302, { location: "/html" });
					response.end();
					return;
				case "/redirect-out":
					response.writeHead(302, { location: "https://example.com/elsewhere" });
					response.end();
					return;
				case "/redirect-bare":
					response.writeHead(302);
					response.end();
					return;
				case "/redirect-loop":
					response.writeHead(302, { location: "/redirect-loop" });
					response.end();
					return;
				case "/big":
					// 不设 Content-Length，走分块传输；上限判定由读取侧完成
					response.writeHead(200, { "content-type": "text/plain" });
					response.end("a".repeat(5000));
					return;
				case "/declared-big":
					response.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
					response.end("b".repeat(100));
					return;
				case "/hang":
					// 故意不响应：只用于验证超时
					return;
				default:
					response.writeHead(404);
					response.end("no");
			}
		});
		base = `http://127.0.0.1:${portOf(server)}`;
	});

	after(() => {
		server.closeAllConnections();
		server.close();
	});

	it("HTML 解码并转成 markdown", async () => {
		const page = await fetchWebPage(`${base}/html`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH);
		assert.equal(page.kind, "html");
		assert.equal(page.statusCode, 200);
		assert.ok(page.content.includes("# Hello"));
		assert.ok(page.content.includes("world"));
		assert.equal(page.content.includes("evil"), false);
		assert.equal(page.truncatedByBytes, false);
	});

	it("latin-1 按 Content-Type 声明解码", async () => {
		const page = await fetchWebPage(`${base}/latin1`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH);
		assert.ok(page.content.includes("café"));
	});

	it("纯文本与 JSON 原样返回", async () => {
		const text = await fetchWebPage(`${base}/text`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH);
		assert.equal(text.kind, "text");
		assert.equal(text.content, "plain body");
		const json = await fetchWebPage(`${base}/json`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH);
		assert.equal(json.content, '{"ok":1}');
	});

	it("同源重定向跟随并落到最终地址", async () => {
		const page = await fetchWebPage(`${base}/redirect`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH);
		assert.ok(page.url.endsWith("/html"));
		assert.ok(page.content.includes("Hello"));
	});

	it("跨源重定向拒绝并指出目标", async () => {
		await assert.rejects(
			fetchWebPage(`${base}/redirect-out`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH),
			/cross-origin redirect to https:\/\/example\.com/,
		);
	});

	it("缺 Location 的重定向拒绝", async () => {
		await assert.rejects(
			fetchWebPage(`${base}/redirect-bare`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH),
			/without a Location header/,
		);
	});

	it("重定向循环撞到跳数上限", async () => {
		await assert.rejects(
			fetchWebPage(`${base}/redirect-loop`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH),
			/exceeded the maximum of 5 redirects/,
		);
	});

	it("二进制内容拒收", async () => {
		await assert.rejects(
			fetchWebPage(`${base}/binary`, DEFAULT_WEB_FETCH_LIMITS, LOOPBACK_FETCH),
			/unsupported content type "image\/png"/,
		);
	});

	it("响应体超过字节上限就地截断并打标记", async () => {
		const limits: WebFetchLimits = { ...DEFAULT_WEB_FETCH_LIMITS, maxResponseBytes: 1000 };
		const page = await fetchWebPage(`${base}/big`, limits, LOOPBACK_FETCH);
		assert.equal(page.truncatedByBytes, true);
		assert.equal(page.content.length, 1000);
	});

	it("声明超限直接拒绝，不读", async () => {
		const limits: WebFetchLimits = { ...DEFAULT_WEB_FETCH_LIMITS, maxResponseBytes: 10 };
		await assert.rejects(
			fetchWebPage(`${base}/declared-big`, limits, LOOPBACK_FETCH),
			/exceeds the maximum of 10 bytes/,
		);
	});

	it("解码后正文字符上限截断并打标记", async () => {
		const limits: WebFetchLimits = { ...DEFAULT_WEB_FETCH_LIMITS, maxBodyChars: 1000 };
		const server2 = await startServer((route, response) => {
			assert.equal(route, "/chars");
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("c".repeat(3000));
		});
		try {
			const page = await fetchWebPage(
				`http://127.0.0.1:${portOf(server2)}/chars`,
				limits,
				LOOPBACK_FETCH,
			);
			assert.equal(page.truncatedByChars, true);
			assert.equal(page.content.length, 1000);
		} finally {
			server2.closeAllConnections();
			server2.close();
		}
	});

	it("不响应的端点按超时报告", async () => {
		const limits: WebFetchLimits = { ...DEFAULT_WEB_FETCH_LIMITS, timeoutMs: 100 };
		await assert.rejects(fetchWebPage(`${base}/hang`, limits, LOOPBACK_FETCH), /timed out after 100 ms/);
	});

	it("默认地址策略拒绝环回主机名与 IP 字面量", async () => {
		// 主机名走 DNS 校验；IP 字面量不经过 lookup，由请求前的就地校验拦截
		await assert.rejects(
			fetchWebPage(`http://localhost:${portOf(server)}/html`, DEFAULT_WEB_FETCH_LIMITS, {
				signal: AbortSignal.timeout(10_000),
			}),
			/refused by the network policy/,
		);
		await assert.rejects(
			fetchWebPage(`${base}/html`, DEFAULT_WEB_FETCH_LIMITS, { signal: AbortSignal.timeout(10_000) }),
			/127\.0\.0\.1 is not a fetchable address/,
		);
	});
});

describe("结果排版", () => {
	it("首行给出地址、状态与截断说明，正文随后", () => {
		const limits = DEFAULT_WEB_FETCH_LIMITS;
		const text = formatFetchedPage(
			{
				url: "https://example.com/a",
				statusCode: 200,
				kind: "text",
				content: "body",
				truncatedByBytes: true,
				truncatedByChars: false,
			},
			limits,
		);
		assert.ok(text.startsWith("Fetched https://example.com/a (HTTP 200; body cut at"));
		assert.ok(text.endsWith("\n\nbody"));
	});
});
