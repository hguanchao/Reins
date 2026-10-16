import type { SessionEntry } from "./port.ts";

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
}

export interface SessionStore {
	/**
	 * 新建一个会话的写入通道。
	 *
	 * 文件要到真正写入时才建立：只是打开程序、看一眼帮助，不该在磁盘上留下一堆空会话。
	 */
	create(options: SessionCreateOptions): SessionWriter;
}
