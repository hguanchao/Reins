import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "../shared/describe-error.ts";

import { checkpointsDir } from "../config/paths.ts";
import {
	GitSnapshotStore,
	type ChangeStatus,
	type SnapshotChange,
} from "./git-snapshot.ts";

/**
 * 检查点服务。
 *
 * 每个用户回合开始前抓一份工作区快照，回合结束后记录实际改动的文件。撤销按回合恢复
 * 文件，不改写对话；恢复前再抓一份安全检查点，让“撤销的撤销”仍然可能。
 *
 * 检查点索引按会话保存，shadow git 仓库按项目共享。所有 git 操作都是 best-effort：
 * 检查点失败不阻断当前回合，界面只提示原因。
 */

export type CheckpointKind = "turn" | "safety";

export interface CheckpointEntry {
	readonly id: string;
	readonly turn: number;
	readonly createdAt: number;
	readonly kind: CheckpointKind;
	readonly label: string;
	/** 相对当前工作区的变更文件数；还没算出来时省略 */
	readonly changes?: number;
}

export interface CheckpointChange extends SnapshotChange {
	readonly status: ChangeStatus;
}

export interface CheckpointPreview {
	readonly entry: CheckpointEntry;
	readonly changes: readonly CheckpointChange[];
}

export interface CheckpointRestoreResult {
	readonly entry: CheckpointEntry;
	readonly restored: number;
	readonly removed: number;
	readonly safety: CheckpointEntry;
}

export class CheckpointError extends Error {}

interface StoredEntry {
	readonly id: string;
	readonly tree: string;
	readonly commit: string;
	readonly turn: number;
	readonly createdAt: number;
	readonly kind: CheckpointKind;
	readonly label: string;
	changes?: readonly SnapshotChange[];
}

interface StoredState {
	readonly version: 1;
	nextTurn: number;
	readonly entries: StoredEntry[];
}

export interface CheckpointServiceOptions {
	readonly workRoot: string;
	readonly sessionId: string;
	/** 测试或多环境隔离用；默认放在 ~/.reins/checkpoints */
	readonly storageDir?: string;
	/** 恢复成功后给下一轮提示词留一条说明 */
	readonly onUndo?: (message: string) => void;
}

/** 一个会话保留的检查点数量；超出后淘汰最旧的条目。 */
const MAX_ENTRIES = 20;

export class CheckpointService {
	readonly #workRoot: string;
	readonly #sessionDir: string;
	readonly #indexPath: string;
	readonly #store: GitSnapshotStore;
	readonly #state: StoredState;
	readonly #onUndo: ((message: string) => void) | undefined;
	#available = false;
	#lastError: string | undefined;

	constructor(options: CheckpointServiceOptions) {
		this.#workRoot = realpathSync(options.workRoot);
		const base = options.storageDir ?? checkpointsDir();
		const project = createHash("sha256").update(this.#workRoot).digest("hex").slice(0, 16);
		const session = options.sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
		const projectDir = join(base, project);
		this.#sessionDir = join(projectDir, "sessions", session);
		this.#indexPath = join(this.#sessionDir, "checkpoints.json");
		this.#store = new GitSnapshotStore(this.#workRoot, join(projectDir, "repo"));
		this.#onUndo = options.onUndo;

		const loaded = loadState(this.#indexPath);
		if (loaded.error !== undefined) {
			this.#lastError = loaded.error;
			this.#state = { version: 1, nextTurn: 1, entries: [] };
		} else {
			this.#state = loaded.state;
		}
	}

	get available(): boolean {
		return this.#available;
	}

	get lastError(): string | undefined {
		return this.#lastError;
	}

	/** 初始化 shadow 仓库与索引；失败时整个会话禁用检查点，但不影响对话。 */
	async init(): Promise<boolean> {
		if (this.#lastError?.startsWith("The checkpoint index")) return false;
		const ready = await this.#store.init();
		if (!ready) {
			this.#lastError = this.#store.error ?? "Could not initialize the checkpoint store";
			this.#available = false;
			return false;
		}
		this.#available = true;
		return true;
	}

	/** 用户回合开始：抓一份新检查点。失败时返回 undefined，不阻断回合。 */
	async captureTurn(): Promise<CheckpointEntry | undefined> {
		if (!this.#available) return undefined;
		const turn = this.#state.nextTurn;
		this.#state.nextTurn += 1;
		const id = `turn-${turn}-${randomBytes(4).toString("hex")}`;
		const label = `Turn ${turn}`;
		const snapshot = await this.#store.capture(id, label);
		if (snapshot === undefined) {
			this.#lastError = this.#store.error ?? "Could not capture a checkpoint";
			return undefined;
		}

		const entry: StoredEntry = {
			id,
			tree: snapshot.tree,
			commit: snapshot.commit,
			turn,
			createdAt: Date.now(),
			kind: "turn",
			label,
		};
		this.#state.entries.push(entry);
		if (!this.#save()) return undefined;
		await this.#prune();
		return summary(entry);
	}

	/** 用户回合结束：记录这一回合实际改动的文件；失败只记原因。 */
	async finalizeTurn(id: string | undefined): Promise<void> {
		if (id === undefined || !this.#available) return;
		const entry = this.#state.entries.find((candidate) => candidate.id === id);
		if (entry === undefined) return;
		try {
			const changes = await this.#store.changes(entry.tree);
			entry.changes = changes;
			this.#save();
			await this.#prune();
		} catch (error) {
			this.#lastError = messageOf(error);
		}
	}

	/** 当前会话的检查点，最新在前。 */
	list(): readonly CheckpointEntry[] {
		return [...this.#state.entries]
			.sort((left, right) => right.createdAt - left.createdAt)
			.map(summary);
	}

	/** 计算某个检查点相对当前工作区会改动什么。 */
	async preview(id: string): Promise<CheckpointPreview> {
		const entry = this.#entry(id);
		const changes = await this.#changesFor(entry);
		return { entry: summary(entry), changes };
	}

	/** 最近一个仍能改动当前工作区的回合检查点；没有时返回 undefined。 */
	async latestUndoable(): Promise<CheckpointPreview | undefined> {
		this.#requireAvailable();
		const turns = [...this.#state.entries]
			.filter((entry) => entry.kind === "turn")
			.sort((left, right) => right.createdAt - left.createdAt);
		for (const entry of turns) {
			const changes = await this.#changesFor(entry);
			if (changes.length > 0) return { entry: summary(entry), changes };
		}
		return undefined;
	}

	/**
	 * 恢复检查点。
	 *
	 * 先抓安全检查点，再恢复目标；恢复失败时安全点仍然保留，可以使用 /checkpoints 恢复。
	 */
	async restore(id: string): Promise<CheckpointRestoreResult> {
		this.#requireAvailable();
		const target = this.#entry(id);
		const turn = this.#state.entries.reduce(
			(max, entry) => (entry.kind === "turn" ? Math.max(max, entry.turn) : max),
			0,
		);
		const safetyId = `safety-${turn}-${randomBytes(4).toString("hex")}`;
		const safetyLabel = `Before ${target.kind === "turn" ? "undo of" : "restore of"} ${target.label}`;
		const safetySnapshot = await this.#store.capture(safetyId, safetyLabel);
		if (safetySnapshot === undefined) {
			throw new CheckpointError(this.#store.error ?? "Could not capture a safety checkpoint");
		}

		const safety: StoredEntry = {
			id: safetyId,
			tree: safetySnapshot.tree,
			commit: safetySnapshot.commit,
			turn,
			createdAt: Date.now(),
			kind: "safety",
			label: safetyLabel,
		};
		this.#state.entries.push(safety);
		if (!this.#save()) {
			throw new CheckpointError("Could not save the safety checkpoint");
		}

		let outcome: { readonly restored: number; readonly removed: number };
		try {
			outcome = await this.#store.restore(target.commit);
			// checkout 接受 commit；用 commit 而不是 tree，避免某些 git 版本对 tree 的路径恢复差异
		} catch (error) {
			throw new CheckpointError(
				`Restore failed: ${messageOf(error)}. The safety checkpoint ${safety.label} is available.`,
			);
		}

		target.changes = [];
		try {
			safety.changes = await this.#store.changes(safety.tree);
		} catch (error) {
			// 文件已经恢复成功；算不出安全点的反向差异只影响 /checkpoints 的计数，不能反报失败
			this.#lastError = messageOf(error);
		}
		this.#save();
		await this.#prune();

		this.#onUndo?.(
			`The user restored ${target.label}. The working tree was rolled back; earlier tool results ` +
				"that described changed files no longer match the files on disk. Re-read files before changing them.",
		);
		return {
			entry: summary(target),
			restored: outcome.restored,
			removed: outcome.removed,
			safety: summary(safety),
		};
	}

	async #changesFor(entry: StoredEntry): Promise<readonly CheckpointChange[]> {
		try {
			const changes = await this.#store.changes(entry.tree);
			entry.changes = changes;
			this.#save();
			return changes;
		} catch (error) {
			throw new CheckpointError(messageOf(error));
		}
	}

	#entry(id: string): StoredEntry {
		this.#requireAvailable();
		const entry = this.#state.entries.find((candidate) => candidate.id === id);
		if (entry === undefined) throw new CheckpointError(`Unknown checkpoint: ${id}`);
		return entry;
	}

	#requireAvailable(): void {
		if (!this.#available) {
			throw new CheckpointError(this.#lastError ?? "Checkpoints are unavailable");
		}
	}

	async #prune(): Promise<void> {
		if (this.#state.entries.length <= MAX_ENTRIES) return;
		const keep = new Set(
			[...this.#state.entries]
				.sort((left, right) => right.createdAt - left.createdAt)
				.slice(0, MAX_ENTRIES)
				.map((entry) => entry.id),
		);
		const removed = this.#state.entries.filter((entry) => !keep.has(entry.id));
		for (const entry of removed) {
			const index = this.#state.entries.indexOf(entry);
			if (index >= 0) this.#state.entries.splice(index, 1);
			await this.#store.forget(entry.id);
		}
		this.#save();
	}

	#save(): boolean {
		try {
			mkdirSync(this.#sessionDir, { recursive: true });
			const temporary = `${this.#indexPath}.tmp`;
			writeFileSync(temporary, JSON.stringify(this.#state), "utf8");
			renameSync(temporary, this.#indexPath);
			return true;
		} catch (error) {
			this.#lastError = `Could not save checkpoints: ${messageOf(error)}`;
			return false;
		}
	}
}

function summary(entry: StoredEntry): CheckpointEntry {
	return {
		id: entry.id,
		turn: entry.turn,
		createdAt: entry.createdAt,
		kind: entry.kind,
		label: entry.label,
		...(entry.changes === undefined ? {} : { changes: entry.changes.length }),
	};
}

/** 索引不存在时是空会话；存在但读不出时才失败关闭，避免静默丢掉恢复点。 */
function loadState(path: string): { state: StoredState; error?: string } {
	if (!existsSync(path)) return { state: { version: 1, nextTurn: 1, entries: [] } };
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		const parsed = parseState(raw);
		if (parsed === undefined) throw new Error("invalid checkpoint index");
		return { state: parsed };
	} catch (error) {
		return {
			state: { version: 1, nextTurn: 1, entries: [] },
			error: `The checkpoint index could not be read; checkpoints are unavailable: ${messageOf(error)}`,
		};
	}
}

function parseState(raw: unknown): StoredState | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	if (value["version"] !== 1 || !Array.isArray(value["entries"])) return undefined;
	const entries: StoredEntry[] = [];
	for (const item of value["entries"]) {
		if (typeof item !== "object" || item === null) return undefined;
		const entry = item as Record<string, unknown>;
		if (
			typeof entry["id"] !== "string" ||
			typeof entry["tree"] !== "string" ||
			typeof entry["commit"] !== "string" ||
			typeof entry["turn"] !== "number" ||
			typeof entry["createdAt"] !== "number" ||
			(entry["kind"] !== "turn" && entry["kind"] !== "safety") ||
			typeof entry["label"] !== "string"
		) {
			return undefined;
		}
		entries.push({
			id: entry["id"],
			tree: entry["tree"],
			commit: entry["commit"],
			turn: entry["turn"],
			createdAt: entry["createdAt"],
			kind: entry["kind"],
			label: entry["label"],
			...(Array.isArray(entry["changes"]) ? { changes: parseChanges(entry["changes"]) } : {}),
		});
	}
	const nextTurn =
		typeof value["nextTurn"] === "number"
			? value["nextTurn"]
			: entries.reduce((max, entry) => (entry.kind === "turn" ? Math.max(max, entry.turn) : max), 0) + 1;
	return { version: 1, nextTurn, entries };
}

function parseChanges(raw: readonly unknown[]): readonly SnapshotChange[] {
	return raw.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const change = item as Record<string, unknown>;
		const status = change["status"];
		if (
			typeof change["path"] !== "string" ||
			(status !== "added" && status !== "modified" && status !== "deleted")
		) {
			return [];
		}
		return [{ path: change["path"], status }];
	});
}

function messageOf(error: unknown): string {
	return describeError(error);
}
