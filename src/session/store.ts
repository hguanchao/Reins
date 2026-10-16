import type { ForkOrigin, SessionEntry, SessionHeaderEntry } from "./port.ts";

/**
 * 会话存储的接缝。
 *
 * 会话的语义——条目、树、折叠、叶子——留在宿主；这里只管「条目怎么落到磁盘上」。换一种存储
 * 只需换一个实现，宿主与驱动一行都不用动。会话仓库由插件提供，因此没有插件时调用方必须显式
 * 决定怎么办（退回内存会话），而不是以为文件已经写下来了。
 */

/** 向一个会话写入条目。落盘细节（建文件、写首行、加锁）由实现负责。 */
export interface SessionWriter {
	/** 写一条已经填好 id、parentId 与时间的条目。 */
	write(entry: SessionEntry): void;
	/** 释放占用的资源，主要是文件锁。 */
	end(): void;
}

export interface SessionCreateOptions {
	readonly id: string;
	readonly cwd: string;
	/** 落盘位置；null 表示只在内存里，此时写入器什么也不做 */
	readonly file: string | null;
	/** 分叉出来的会话要记下出处 */
	readonly forkedFrom?: ForkOrigin;
}

/** 读出来的会话文件。 */
export interface SessionFile {
	readonly header: SessionHeaderEntry | undefined;
	readonly entries: readonly SessionEntry[];
}

/** 会话在清单里的一行。 */
export interface SessionListing {
	readonly id: string;
	readonly file: string;
	/** 更新时间，按它从新到旧排序 */
	readonly updatedAt: string;
	readonly entryCount: number;
	/** 第一条使用者说的话，够认出是哪个会话就行 */
	readonly title: string | undefined;
	readonly forkedFrom: ForkOrigin | undefined;
}

export interface SessionStore {
	/**
	 * 新建一个会话的写入通道。
	 *
	 * 文件要到真正写入时才建立：只是打开程序、看一眼帮助，不该在磁盘上留下一堆空会话。
	 */
	create(options: SessionCreateOptions): SessionWriter;
	/** 读一个既有会话文件。只读，不占锁——看历史不该妨碍别处继续写。 */
	read(file: string): SessionFile;
	/** 接续一个既有会话文件：不写首行，直接往后追加。 */
	append(file: string): SessionWriter;
	/** 列出目录里的会话，按更新时间从新到旧。目录不存在时返回空清单。 */
	list(dir: string): readonly SessionListing[];
}
