/**
 * 服务进程的就绪行。
 *
 * serve 起来之后,壳(桌面主进程、未来的任何启动器)需要知道端口与令牌。约定只有一条:
 * stdout 上写一行 `reins-ready {...}`,其余输出都给人看。壳逐行扫这一行,别的行不认识就跳过。
 */

export interface ReadyInfo {
	readonly port: number;
	readonly token: string;
}

const PREFIX = "reins-ready ";

export function formatReadyLine(info: ReadyInfo): string {
	return PREFIX + JSON.stringify(info);
}

/** 从一行输出里解析就绪信息;不是就绪行或形状不对时返回 undefined。 */
export function parseReadyLine(line: string): ReadyInfo | undefined {
	if (!line.startsWith(PREFIX)) return undefined;
	try {
		const parsed: unknown = JSON.parse(line.slice(PREFIX.length));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const port = (parsed as { port?: unknown }).port;
		const token = (parsed as { token?: unknown }).token;
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return undefined;
		if (typeof token !== "string" || token.length === 0) return undefined;
		return { port, token };
	} catch {
		return undefined;
	}
}
