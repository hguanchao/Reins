import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * 会话文件的单写者锁。
 *
 * 两个进程同时往同一个会话文件追加，得到的是两段交错的历史：每条记录本身都完整，但顺序
 * 已经不是任何一方以为的样子。所以这里用锁把「同一时刻只有一个写者」这件事明确下来，
 * 拿不到锁就直接拒绝，而不是让两边都以为写成功了。
 *
 * 进程被强杀时锁文件会留下。这里不自动抢夺：判断「持有者已经死了」需要跨平台的进程探测，
 * 猜错会把正在写入的会话交出去。锁文件里记着持有者信息，报错时一并给出，由使用者决定删不删。
 */
export class SessionLock {
	readonly #path: string;
	#released = false;

	private constructor(path: string) {
		this.#path = path;
	}

	/** 取得锁。已被占用时抛错，错误信息里带上原持有者的信息。 */
	static acquire(sessionFile: string): SessionLock {
		const path = `${sessionFile}.lock`;
		let handle: number | undefined;
		try {
			handle = openSync(path, "wx");
			writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`);
			closeSync(handle);
			handle = undefined;
			return new SessionLock(path);
		} catch (error) {
			// 写入或关闭失败时句柄要自己收掉，否则锁文件再也关不上,fd 也回不去
			if (handle !== undefined) {
				try {
					closeSync(handle);
				} catch {
					// 关闭失败没有可做的：锁文件留在原地，由持有者检测逻辑兜底
				}
				try {
					unlinkSync(path);
				} catch {
					// 同上，残留的半截锁文件交给下一次取锁时的报错去说明
				}
			}
			if (!isAlreadyExists(error)) throw error;
			throw new Error(
				`Session file is locked: ${path} (held by ${describeHolder(path)}). ` +
					"Check that no other process is writing this session, then delete the lock file and try again.",
			);
		}
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		try {
			unlinkSync(this.#path);
		} catch {
			// 锁文件已经不在了说明目标状态已经达成，不必打扰调用方
		}
	}
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function describeHolder(path: string): string {
	if (!existsSync(path)) return "unknown";
	try {
		return readFileSync(path, "utf8").trim() || "unknown";
	} catch {
		return "unknown";
	}
}
