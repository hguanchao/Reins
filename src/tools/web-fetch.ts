import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { TextDecoder } from "node:util";

import { Agent, fetch as httpFetch } from "undici";
import { createDocument, type DominoNode } from "domino";
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

/**
 * web_fetch 的抓取引擎。
 *
 * 网络抓取是模型能主动发出的对外请求，这一层的安全规则全部收在这里并在宿主实现：
 * 只收 http(s)、拒绝带凭据的 URL、每次连接都把域名解析到具体 IP 后按「仅公网地址」放行
 * 再照着这个 IP 连接（防 DNS 重绑定绕过）、重定向只在同源内跟、只解码文本类内容。
 * 抓回来的是文本这一事实由这里保证，HTML 转成 markdown 也只在这里发生。
 */

/** 抓取上限。数值是固定取舍，不是配置项：放宽它们等于放宽安全边界。 */
export interface WebFetchLimits {
	readonly timeoutMs: number;
	readonly maxRedirects: number;
	readonly maxResponseBytes: number;
	/** 解码后正文的字符上限；超出即截断并打标记 */
	readonly maxBodyChars: number;
	readonly userAgent: string;
}

export const DEFAULT_WEB_FETCH_LIMITS: WebFetchLimits = {
	timeoutMs: 20_000,
	maxRedirects: 5,
	maxResponseBytes: 5 * 1024 * 1024,
	maxBodyChars: 200_000,
	userAgent: "Reins-web-fetch",
};

/** URL 长度上限：超长的 URL 几乎总是注入尝试，正常页面地址远短于此。 */
const MAX_URL_LENGTH = 2048;

/** 一次成功抓取的结果；markdown 已是最终形态。 */
export interface FetchedPage {
	/** 跟完重定向后真正取到内容的地址 */
	readonly url: string;
	readonly statusCode: number;
	readonly kind: "html" | "text";
	readonly content: string;
	readonly truncatedByBytes: boolean;
	readonly truncatedByChars: boolean;
}

type FetchResponse = Awaited<ReturnType<typeof httpFetch>>;

/** 抓取的入口。filter 决定哪些解析地址可连；默认只放公网，测试时才允许别的策略。 */
export async function fetchWebPage(
	rawUrl: string,
	limits: WebFetchLimits,
	options: {
		readonly signal?: AbortSignal;
		readonly addressFilter?: (address: string) => boolean;
	} = {},
): Promise<FetchedPage> {
	const agent = new Agent({
		connect: { lookup: createPinnedLookup(options.addressFilter ?? isPublicAddress) },
	});
	// 超时与调用方中止合成一个信号；区分两者靠看各自的信号，而不是看抛出的错误形态
	const timeoutSignal = AbortSignal.timeout(limits.timeoutMs);
	const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
	const filter = options.addressFilter ?? isPublicAddress;

	try {
		return await followAndRead(rawUrl, limits, agent, signal, filter);
	} catch (error) {
		if (timeoutSignal.aborted) throw new Error(`web fetch timed out after ${limits.timeoutMs} ms`);
		if (options.signal?.aborted) throw new Error("web fetch aborted");
		throw unwrapOpaqueFetchError(error);
	} finally {
		await agent.close().catch(() => {});
	}
}

/** undici 把连接层错误包成没有信息量的「fetch failed」；沿 cause 链把真正的错误剥出来。 */
function unwrapOpaqueFetchError(error: unknown): unknown {
	let current = error;
	for (let depth = 0; depth < 3 && current instanceof Error && current.message === "fetch failed"; depth += 1) {
		current = current.cause ?? current;
	}
	return current;
}

/** 把一行结果拼成交给模型的正文；截断说明放首行，正文保持干净（尾注是落盘机制的契约）。 */
export function formatFetchedPage(page: FetchedPage, limits: WebFetchLimits): string {
	let header = `Fetched ${page.url} (HTTP ${page.statusCode}`;
	if (page.truncatedByBytes) header += `; body cut at ${limits.maxResponseBytes} bytes`;
	if (page.truncatedByChars) header += `; text cut at ${limits.maxBodyChars} characters`;
	header += ")";
	return `${header}\n\n${page.content}`;
}

/** 跟随同源重定向直到拿到最终响应。 */
async function followAndRead(
	rawUrl: string,
	limits: WebFetchLimits,
	agent: Agent,
	signal: AbortSignal,
	filter: (address: string) => boolean,
): Promise<FetchedPage> {
	let currentUrl = validateFetchUrl(rawUrl);
	assertHostAllowed(currentUrl, filter);
	let redirectsFollowed = 0;

	for (;;) {
		const response = await httpFetch(currentUrl, {
			method: "GET",
			redirect: "manual",
			dispatcher: agent,
			headers: {
				"user-agent": limits.userAgent,
				accept: "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8",
			},
			signal,
		});

		if (!isRedirectStatus(response.status)) {
			return await readBody(response, currentUrl, limits);
		}

		// 重定向的每一跳都要重新过一遍完整校验：Location 不许借道把带凭据、非 http(s) 或
		// 超长的 URL 送进来，也不许跨源——跨源意味着换了一个使用者没见过的地方
		const location = response.headers.get("location");
		await discardBody(response);
		if (location === null) {
			throw new Error(`redirect response (HTTP ${response.status}) without a Location header`);
		}
		if (redirectsFollowed >= limits.maxRedirects) {
			throw new Error(`exceeded the maximum of ${limits.maxRedirects} redirects`);
		}
		const target = validateFetchUrl(new URL(location, currentUrl).toString());
		assertHostAllowed(target, filter);
		if (!isSameOrigin(target, currentUrl)) {
			throw new Error(
				`cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`,
			);
		}
		currentUrl = target;
		redirectsFollowed += 1;
	}
}

/** 读最终响应体：分类、限长、解码，HTML 就地转成 markdown。 */
async function readBody(
	response: FetchResponse,
	finalUrl: URL,
	limits: WebFetchLimits,
): Promise<FetchedPage> {
	const contentType = response.headers.get("content-type");
	const kind = classifyContentType(contentType);
	if (kind === undefined) {
		await discardBody(response);
		throw new Error(`unsupported content type "${contentType ?? "unknown"}"; only text-like bodies are decoded`);
	}

	const decoder = decoderForCharset(contentType);
	const { bytes, truncatedByBytes } = await readCapped(response, limits);
	let decoded: string;
	try {
		// 只有真的因字节上限截断才允许尾部的半个多字节字符：解码器按续流处理就不会报错
		decoded = decoder.decode(bytes, { stream: decoder.fatal && truncatedByBytes });
	} catch {
		throw new Error("response body is not valid text for its declared charset");
	}

	const truncatedByChars = decoded.length > limits.maxBodyChars;
	const content = truncatedByChars ? decoded.slice(0, limits.maxBodyChars) : decoded;
	return {
		url: finalUrl.toString(),
		statusCode: response.status,
		kind,
		content: kind === "html" ? htmlToMarkdown(content) : content,
		truncatedByBytes,
		truncatedByChars,
	};
}

/** 读响应体，超过字节上限就地切断；声明超限直接拒绝，不读。 */
async function readCapped(
	response: FetchResponse,
	limits: WebFetchLimits,
): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
	const declared = response.headers.get("content-length");
	const declaredLength = declared === null ? Number.NaN : Number(declared);
	if (Number.isFinite(declaredLength) && declaredLength > limits.maxResponseBytes) {
		await discardBody(response);
		throw new Error(`response exceeds the maximum of ${limits.maxResponseBytes} bytes`);
	}

	if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncatedByBytes = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			// 恰好填满不算截断：还要读到 EOF 才知道内容真的到此为止
			const remaining = limits.maxResponseBytes - total;
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining));
				total += remaining;
				truncatedByBytes = true;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		// 读满切断或正常读完都要还掉连接；best-effort，失败不掩盖正文
		await reader.cancel().catch(() => {});
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncatedByBytes };
}

async function discardBody(response: FetchResponse): Promise<void> {
	// 不打算读的响应也要把连接还回去；取消失败只说明连接稍后由底层回收
	await response.body?.cancel().catch(() => {});
}

/** 校验请求与重定向目标；所有网络请求前的 URL 都必须过这一道。 */
export function validateFetchUrl(input: string): URL {
	if (input.length > MAX_URL_LENGTH) {
		throw new Error(`URL exceeds the maximum length of ${MAX_URL_LENGTH} characters`);
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`invalid URL: ${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`unsupported URL scheme "${url.protocol}"; only http and https are allowed`);
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new Error("credentials in URLs are not allowed");
	}
	return url;
}

function isSameOrigin(left: URL, right: URL): boolean {
	return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** IP 字面量主机不经过 DNS lookup，连接层拦不到；必须在请求前就地校验。 */
function assertHostAllowed(url: URL, filter: (address: string) => boolean): void {
	const host = url.hostname;
	const isLiteral = host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
	if (isLiteral && !filter(host)) {
		throw new Error(`${host} is not a fetchable address: refused by the network policy`);
	}
}

/** 响应体是不是本引擎能解码的文本；其余（图片、压缩流、二进制）一律拒收。 */
export function classifyContentType(contentType: string | null): "html" | "text" | undefined {
	const mime = (contentType ?? "").replace(/;.*$/s, "").trim().toLowerCase();
	if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
	if (mime.startsWith("text/")) return "text";
	if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) {
		return "text";
	}
	return undefined;
}

/** 从 Content-Type 解出字符集并给出解码器；不认识的声明按错误拒绝，不猜。 */
function decoderForCharset(contentType: string | null): TextDecoder {
	const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? "");
	const declared = match?.[1]?.trim().toLowerCase() ?? "utf-8";
	try {
		return new TextDecoder(declared);
	} catch {
		// 声明里混了分隔符或多写法时，其中一个是 UTF-8 的别名就按 UTF-8 解；仍不认识才拒绝
		const labels = declared.split(/[\s,]+/);
		if (labels.some((label) => isUtf8Label(label))) return new TextDecoder("utf-8");
		throw new Error(`unsupported charset "${declared}"`);
	}
}

function isUtf8Label(label: string): boolean {
	if (label.length === 0) return false;
	try {
		return new TextDecoder(label).encoding === "utf-8";
	} catch {
		return false;
	}
}

/**
 * 公网地址判定。
 *
 * 解析出私网、环回、链路本地或保留段的地址一律拒绝：模型借此探测内部服务比读不到文档
 * 严重得多。六种过渡技术（6to4、Teredo、NAT64 这类内嵌 IPv4 的段）也按保守一侧拒绝。
 */
export function isPublicAddress(address: string): boolean {
	return address.includes(":") ? isPublicIpv6(address) : isPublicIpv4(address);
}

function isPublicIpv4(address: string): boolean {
	const parts = address.split(".");
	if (parts.length !== 4) return false;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return false;
		const value = Number(part);
		if (value > 255) return false;
		octets.push(value);
	}
	const [a, b] = octets as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return false; // 本网络、私网、环回
	if (a === 169 && b === 254) return false; // 链路本地
	if (a === 172 && b >= 16 && b <= 31) return false; // 私网
	if (a === 100 && b >= 64 && b <= 127) return false; // 运营商级 NAT
	if (a === 192 && b === 168) return false; // 私网
	if (a === 192 && (b === 0 && (octets[2] === 0 || octets[2] === 2))) return false; // 协议保留与测试段
	if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试段
	if (a === 198 && b === 51 && octets[2] === 100) return false; // 测试段
	if (a === 203 && b === 0 && octets[2] === 113) return false; // 测试段
	if (a >= 224) return false; // 组播与保留段
	return true;
}

function isPublicIpv6(address: string): boolean {
	const lowered = address.toLowerCase().split("%")[0] ?? "";
	if (lowered === "::" || lowered === "::1") return false;
	if (lowered.includes(".")) {
		// 只有 v4 映射地址（第六组为 ffff、之前全零）按内嵌 IPv4 判定；6to4 与 NAT64 的
		// 带点写法不属于映射，一律拒绝
		const tail = lowered.slice(lowered.lastIndexOf(":") + 1);
		const groups = lowered
			.slice(0, lowered.lastIndexOf(":"))
			.split(":")
			.filter((part) => part.length > 0);
		const isMapped =
			groups.length > 0 &&
			groups[groups.length - 1] === "ffff" &&
			groups.slice(0, -1).every((part) => Number.parseInt(part, 16) === 0);
		return isMapped ? isPublicIpv4(tail) : false;
	}

	const leading = leadingHextets(lowered);
	const first = leading[0];
	if (first === undefined || first === 0) return false; // 全零前缀只出现在未指定/环回的全展开写法里
	if ((first & 0xff00) === 0xff00) return false; // 组播
	if (first >= 0xfe80 && first <= 0xfeff) return false; // 链路本地与已废弃的站点本地
	if (first >= 0xfc00 && first <= 0xfdff) return false; // 唯一本地地址
	if (first === 0x0100) return false; // 丢弃专用段
	if (first === 0x2002) return false; // 6to4 内嵌 IPv4
	// Teredo 的 /32 是 2001:0000::/32；压缩写法「2001::」里第二个分组被吞掉，同样按零处理
	if (first === 0x2001 && (leading[1] === undefined || leading[1] === 0)) return false;
	if (first === 0x2001 && leading[1] === 0x0db8) return false; // 文档专用段
	if (first === 0x0064 && leading[1] === 0xff9b) return false; // NAT64 内嵌 IPv4
	return true;
}

/** 取「::」之前的前导十六位组；没有压缩写法时是全部分组。 */
function leadingHextets(address: string): readonly number[] {
	const compressedAt = address.indexOf("::");
	const head = compressedAt === -1 ? address : address.slice(0, compressedAt);
	const groups = head.split(":").filter((part) => part.length > 0);
	const values: number[] = [];
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return [];
		values.push(Number.parseInt(group, 16));
	}
	return values;
}

/**
 * 生成「解析后立即校验、照校验过的地址连接」的 DNS lookup。
 *
 * 连接使用的地址就是这个函数挑出的地址，TLS 的服务器名仍取 URL 里的主机名：解析与连接
 * 之间不存在换址窗口，改 hosts 也绕不过地址校验。
 */
function createPinnedLookup(filter: (address: string) => boolean): LookupFunction {
	return (hostname, options, callback) => {
		lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
			if (error !== null) {
				callback(error, "", 0);
				return;
			}
			const allowed = addresses.filter((entry) => filter(entry.address));
			const wanted = normalizeFamily(options.family);
			const picked =
				wanted === undefined ? allowed[0] : allowed.find((entry) => entry.family === wanted) ?? allowed[0];
			if (picked === undefined) {
				callback(
					new Error(
						`hostname ${hostname} has no fetchable address: all resolved addresses are refused by the network policy`,
					),
					"",
					0,
				);
				return;
			}
			callback(null, picked.address, picked.family);
		});
	};
}

function normalizeFamily(family: number | string | undefined): 4 | 6 | undefined {
	if (family === 4 || family === "IPv4") return 4;
	if (family === 6 || family === "IPv6") return 6;
	return undefined;
}

/** 模型可见的正文只认这些元素；更深处的病态嵌套不再展开，避免转换被页面拖死。 */
const NON_VISIBLE_ELEMENTS = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"iframe",
	"svg",
	"canvas",
	"object",
	"embed",
]);

const MAX_ELEMENT_DEPTH = 40;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndown.use(gfm);

/** HTML 转 markdown；转换前剥掉不可见元素、把超深嵌套折叠成纯文本。 */
export function htmlToMarkdown(html: string): string {
	const document = createDocument(html);
	const root = document.body;
	if (root === null) return "";
	cleanTree(document, root, 0);
	return turndown.turndown(root).trim();
}

function cleanTree(document: ReturnType<typeof createDocument>, node: DominoNode, depth: number): void {
	const children: DominoNode[] = [];
	for (let index = 0; index < node.childNodes.length; index += 1) {
		const child = node.childNodes[index];
		if (child !== undefined) children.push(child);
	}
	for (const child of children) {
		const isElement = child.nodeType === 1;
		if (isElement && NON_VISIBLE_ELEMENTS.has(child.nodeName.toLowerCase())) {
			node.removeChild(child);
			continue;
		}
		if (isElement && depth >= MAX_ELEMENT_DEPTH) {
			// 深处的内容对模型已经没有结构价值；折叠成纯文本，转换的树高由此有界
			node.replaceChild(document.createTextNode(child.textContent), child);
			continue;
		}
		if (isElement) cleanTree(document, child, depth + 1);
	}
}
