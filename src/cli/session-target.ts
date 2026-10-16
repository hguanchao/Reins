import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { sessionsDir } from "../config/paths.ts";
import { Session } from "../session/session.ts";
import type { SessionListing, SessionStore } from "../session/store.ts";
import type { CliOptions } from "./args.ts";

/**
 * 这次运行要用哪个会话。
 *
 * 三种来法：新建（默认）、接续（--continue 或 --resume）、分叉（在接续的基础上 --fork）。
 * 选择逻辑放在这里而不是装配处，是为了能单独验证：接续与分叉最容易做错的地方是「接错了
 * 会话」或「把原会话改了」，这两件事都只靠这几个函数决定。
 */

export interface SessionTarget {
	readonly workRoot: string;
	/** 会话仓库；没有它就只能新建内存会话 */
	readonly store: SessionStore | undefined;
}

/**
 * 按命令行选项准备会话。
 *
 * 没有会话仓库时新建仍然可用（会话只留在内存里），但要接续或分叉就必须明确报错：读不到
 * 历史时悄无声息地开一个新会话，使用者会以为自己在接着原来的话题。
 */
export function openSession(options: CliOptions, target: SessionTarget): Session {
	const { workRoot, store } = target;
	const wantsExisting = options.continueSession || options.resume !== undefined;

	if (!wantsExisting) {
		return createSession(workRoot, store);
	}
	if (store === undefined) {
		throw new Error("会话存储没有装载（session-plugin 被禁用或装载失败），无法接续或分叉会话");
	}

	const listings = store.list(sessionsDir(workRoot));
	// 清单按更新时间从新到旧：最近更新过的那个就是 --continue 要找的
	const listing =
		options.resume === undefined ? listings[0] : resolveListing(listings, options.resume);
	if (listing === undefined) {
		throw new Error(
			options.resume === undefined
				? `${workRoot} 下没有可以接续的会话`
				: `没有找到会话 ${options.resume}；用 reins sessions list 看看有哪些`,
		);
	}

	const source = Session.open(listing.file, store);
	if (!options.fork) return source;

	return Session.fork(source, {
		id: randomBytes(8).toString("hex"),
		cwd: workRoot,
		file: sessionFilePath(workRoot),
		store,
		...(options.forkAt === undefined ? {} : { at: options.forkAt }),
	});
}

/** 新建一个会话。没有仓库时退回内存会话，这件事由调用方负责告诉使用者。 */
export function createSession(workRoot: string, store: SessionStore | undefined): Session {
	const id = randomBytes(8).toString("hex");
	if (store === undefined) return new Session({ id, cwd: workRoot, file: null });

	const file = sessionFilePath(workRoot);
	return new Session({ id, cwd: workRoot, file, writer: store.create({ id, cwd: workRoot, file }) });
}

/** 按标识找一个会话：先按完整标识，再按唯一前缀。找不到或有歧义都如实报错。 */
export function resolveListing(
	listings: readonly SessionListing[],
	ref: string,
): SessionListing | undefined {
	const exact = listings.find((listing) => listing.id === ref);
	if (exact !== undefined) return exact;

	const matches = listings.filter((listing) => listing.id.startsWith(ref));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(`标识 ${ref} 不唯一，可能是：${matches.map((item) => item.id).join("、")}`);
	}
	return undefined;
}

/**
 * 会话文件路径。
 *
 * 文件名里带创建时间，便于按时间找人；后缀是短随机串，避免同一秒内启动两次时撞名。
 */
export function sessionFilePath(workRoot: string): string {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return join(sessionsDir(workRoot), `${stamp}_${randomBytes(4).toString("hex")}.jsonl`);
}
