import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ChangeStatus = "added" | "modified" | "deleted";

export interface SnapshotChange {
	readonly path: string;
	readonly status: ChangeStatus;
}

export interface Snapshot {
	readonly tree: string;
	readonly commit: string;
}

/**
 * 工作区快照的 git 实现。
 *
 * 用独立的 shadow 仓库保存工作区的 tree：工作区自己的 `.git`、分支、暂存区一概不碰。
 * shadow 仓库与项目共享 objects（alternates），已存在的 blob 不重复写；每回合只刷新
 * 变化过的文件，而不是重新复制整个工作区。
 *
 * 只接受工作根本身就是 git 仓库根的情况：否则 `.gitignore` 的层级与恢复边界都会变得
 * 难以解释，宁可明确不支持，也不做一套半准确的备份。
 */
export class GitSnapshotStore {
	readonly workRoot: string;
	readonly #storageRoot: string;
	readonly #repoRoot: string;
	readonly #gitDir: string;
	readonly #configFile: string;
	#ready = false;
	#error: string | undefined;

	constructor(workRoot: string, storageRoot: string) {
		this.workRoot = realpathSync(workRoot);
		this.#storageRoot = storageRoot;
		this.#repoRoot = join(storageRoot, "repo");
		this.#gitDir = join(this.#repoRoot, ".git");
		this.#configFile = join(storageRoot, "gitconfig");
	}

	get error(): string | undefined {
		return this.#error;
	}

	get ready(): boolean {
		return this.#ready;
	}

	/** 初始化 shadow 仓库；失败时记录原因并返回 false。 */
	async init(): Promise<boolean> {
		if (this.#ready) return true;
		if (this.#error !== undefined) return false;

		try {
			let top: string;
			try {
				top = (await this.#source(["rev-parse", "--show-toplevel"])).trim();
			} catch {
				throw new Error("Checkpoints need a Git repository at the workspace root");
			}
			if (realpathSync(top) !== this.workRoot) {
				throw new Error(
					"Checkpoints need the workspace root to be the root of a Git repository",
				);
			}
			const common = (await this.#source(["rev-parse", "--git-common-dir"])).trim();
			const sourceObjects = join(isAbsolute(common) ? common : resolve(this.workRoot, common), "objects");

			mkdirSync(this.#storageRoot, { recursive: true });
			if (!existsSync(this.#configFile)) writeFileSync(this.#configFile, "");
			if (!existsSync(join(this.#gitDir, "HEAD"))) {
				mkdirSync(this.#repoRoot, { recursive: true });
				await run("git", ["init", "--quiet", this.#repoRoot], {
					cwd: this.#storageRoot,
					env: this.#baseEnv(),
					windowsHide: true,
					maxBuffer: 8 * 1024 * 1024,
				});
			}

			mkdirSync(join(this.#gitDir, "info"), { recursive: true });
			// 工作区里的 .git 不属于快照；其余忽略规则由工作区的 .gitignore / .git/info/exclude 决定
			writeFileSync(join(this.#gitDir, "info", "exclude"), ".git/\n");
			mkdirSync(join(this.#gitDir, "objects", "info"), { recursive: true });
			writeFileSync(join(this.#gitDir, "objects", "info", "alternates"), `${sourceObjects}\n`);

			this.#ready = true;
			return true;
		} catch (error) {
			this.#error = messageOf(error);
			return false;
		}
	}

	/** 抓取当前工作区，写入一个可长期保留的 commit 与 ref。 */
	async capture(id: string, label: string): Promise<Snapshot | undefined> {
		if (!(await this.init())) return undefined;
		try {
			const tree = await this.#writeTree();
			const commit = (await this.#git(["commit-tree", tree, "-m", label])).trim();
			await this.#git(["update-ref", `refs/reins/${id}`, commit]);
			return { tree, commit };
		} catch (error) {
			this.#error = messageOf(error);
			return undefined;
		}
	}

	/** 目标快照与当前工作区的差异；当前状态也会刷新 shadow index。 */
	async changes(target: string): Promise<readonly SnapshotChange[]> {
		const current = await this.#writeTree();
		return this.#diff(target, current);
	}

	/**
	 * 把目标快照恢复到工作区。
	 *
	 * 先删除目标里没有的当前文件，再批量 checkout 目标中的文件；只动差异路径，不覆盖
	 * 与这次检查点无关的文件。路径仍做边界校验，git 输出不能越出工作根。
	 */
	async restore(
		target: string,
	): Promise<{ readonly restored: number; readonly removed: number }> {
		const current = await this.#writeTree();
		const changes = await this.#diff(target, current);
		const added = changes.filter((change) => change.status === "added");
		const restorePaths = changes
			.filter((change) => change.status !== "added")
			.map((change) => change.path);

		for (const change of added) rmWorkspacePath(this.workRoot, change.path);
		// 文件/目录互换时目标路径可能先以目录存在；清掉它才能 checkout 出文件
		for (const path of restorePaths) {
			const absolute = workspacePath(this.workRoot, path);
			try {
				if (lstatSync(absolute).isDirectory()) rmSync(absolute, { recursive: true, force: true });
			} catch {
				// 不存在或读不到时交给 checkout 报错
			}
		}

		for (const chunk of chunks(restorePaths, 100)) {
			await this.#git(["checkout", target, "--", ...chunk]);
		}
		return { restored: restorePaths.length, removed: added.length };
	}

	/** 删除一个检查点的 ref；对象留给 git 自己回收。 */
	async forget(id: string): Promise<void> {
		try {
			await this.#git(["update-ref", "-d", `refs/reins/${id}`]);
		} catch {
			// 清理失败不影响检查点本身，下一次 gc 会处理不可达对象
		}
	}

	async #writeTree(): Promise<string> {
		await this.#git(["add", "-A"]);
		return (await this.#git(["write-tree"])).trim();
	}

	async #diff(target: string, current: string): Promise<readonly SnapshotChange[]> {
		const output = await this.#git([
			"diff",
			"--name-status",
			"--no-renames",
			"-z",
			target,
			current,
		]);
		const tokens = output.split("\0");
		const changes: SnapshotChange[] = [];
		for (let index = 0; index + 1 < tokens.length; index += 2) {
			const code = tokens[index] ?? "";
			const path = tokens[index + 1] ?? "";
			if (path.length === 0) continue;
			const status = changeStatus(code);
			if (status !== undefined) changes.push({ path, status });
		}
		return changes;
	}

	async #git(args: readonly string[]): Promise<string> {
		const result = await run(
			"git",
			["--git-dir", this.#gitDir, "--work-tree", this.workRoot, ...args],
			{
				cwd: this.workRoot,
				env: this.#baseEnv(),
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		return result.stdout;
	}

	async #source(args: readonly string[]): Promise<string> {
		const result = await run("git", args, {
			cwd: this.workRoot,
			env: this.#baseEnv(),
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
		});
		return result.stdout;
	}

	#baseEnv(): NodeJS.ProcessEnv {
		return {
			...process.env,
			GIT_CONFIG_GLOBAL: this.#configFile,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "Reins",
			GIT_AUTHOR_EMAIL: "reins@localhost",
			GIT_COMMITTER_NAME: "Reins",
			GIT_COMMITTER_EMAIL: "reins@localhost",
		};
	}
}

function changeStatus(code: string): ChangeStatus | undefined {
	switch (code.charAt(0)) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "M":
		case "T":
			return "modified";
		default:
			return undefined;
	}
}

function workspacePath(workRoot: string, path: string): string {
	const absolute = resolve(workRoot, path);
	const inside = relative(workRoot, absolute);
	if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
		throw new Error(`Snapshot path escapes the workspace: ${path}`);
	}
	return absolute;
}

function rmWorkspacePath(workRoot: string, path: string): void {
	const absolute = workspacePath(workRoot, path);
	try {
		const stats = lstatSync(absolute);
		if (stats.isDirectory()) rmSync(absolute, { recursive: true, force: true });
		else rmSync(absolute, { force: true });
	} catch {
		// 已经不存在的文件不需要再删
	}
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
	const output: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		output.push(items.slice(index, index + size));
	}
	return output;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
