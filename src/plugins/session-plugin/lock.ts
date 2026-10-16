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
		try {
			const handle = openSync(path, "wx");
			writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`);
			closeSync(handle);
			return new SessionLock(path);
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			throw new Error(
				`会话文件已被占用：${path}（持有者 ${describeHolder(path)}）。` +
					"确认没有其他进程在写这个会话后，删除该锁定文件再试。",
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
	if (!existsSync(path)) return "未知";
	try {
		return readFileSync(path, "utf8").trim() || "未知";
	} catch {
		return "未知";
	}
}
