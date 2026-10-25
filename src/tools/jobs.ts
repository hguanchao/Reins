import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionReadView } from "../session/port.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import type { ToolDefinition, ToolResult } from "./contract.ts";
import { formatDuration } from "../shared/format.ts";
import { MAX_CAPTURED_BYTES, resolveShell, startShellProcess, type ShellProcess } from "./shell.ts";
import type { JsonSchema } from "./schema.ts";
import { DEFAULT_LIMITS, truncateTail } from "./truncate.ts";

/**
 * 后台作业。
 *
 * 作业跨回合并存，但只活在当前 Reins 进程里：退出时统一终止，不做跨进程恢复。输出由
 * shell 进程的环形缓冲保存；模型用 job_output 取快照或短等待，界面用同一份数据画 Jobs bar。
 */

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface JobView {
	readonly id: string;
	readonly command: string;
	readonly status: JobStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	readonly timedOut?: boolean;
	readonly overflowed?: boolean;
	readonly sessionId: string;
}

export interface JobEvent {
	readonly type: "started" | "finished";
	readonly job: JobView;
}

export interface JobStartInput {
	readonly command: string;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
	readonly timeoutSeconds?: number;
}

interface ActiveJob {
	info: JobView;
	readonly process: ShellProcess;
	timedOut: boolean;
	killRequested: boolean;
	readonly done: Promise<void>;
	resolveDone: () => void;
}

export interface JobManagerOptions {
	readonly shellPath?: string;
}

/** 最多保留多少条已结束作业；运行中的永远保留。 */
const COMPLETED_LIMIT = 20;

export class JobManager {
	readonly #shellPath: string | undefined;
	readonly #jobs = new Map<string, ActiveJob>();
	readonly #listeners = new Set<(event: JobEvent) => void>();
	#next = 0;

	constructor(options: JobManagerOptions = {}) {
		this.#shellPath = options.shellPath;
	}

	/** 启动一条后台命令；shell 选择失败直接抛错，spawn 失败会落成 failed 作业。 */
	start(input: JobStartInput): JobView {
		const shell = resolveShell(undefined, this.#shellPath);
		const shellProcess = startShellProcess({
			shell,
			command: input.sandbox.wrapCommand(input.command),
			cwd: input.workspace.root,
			env: {
				...shell.env,
				...process.env,
				REINS_SESSION_ID: input.session.id,
				...(input.session.path === null ? {} : { REINS_SESSION_FILE: input.session.path }),
			},
			maxBytes: MAX_CAPTURED_BYTES,
		});
		const id = `j${++this.#next}`;
		let resolveDone = (): void => {};
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const job: ActiveJob = {
			info: {
				id,
				command: input.command,
				status: "running",
				startedAt: Date.now(),
				sessionId: input.session.id,
			},
			process: shellProcess,
			timedOut: false,
			killRequested: false,
			done,
			resolveDone,
		};
		this.#jobs.set(id, job);
		this.#prune();

		const timeoutMs = (input.timeoutSeconds ?? 0) * 1000;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						job.timedOut = true;
						shellProcess.kill();
					}, timeoutMs)
				: undefined;

		void shellProcess.wait().then((exit) => {
			if (timer !== undefined) clearTimeout(timer);
			const status: JobStatus = job.killRequested
				? "killed"
				: job.timedOut || !exit.started || (exit.code !== null && exit.code !== 0)
					? "failed"
					: "done";
			job.info = {
				...job.info,
				status,
				endedAt: Date.now(),
				exitCode: exit.code,
				...(job.timedOut ? { timedOut: true } : {}),
			};
			job.resolveDone();
			this.#prune();
			this.#emit({ type: "finished", job: this.#snapshot(job) });
		});

		this.#emit({ type: "started", job: this.#snapshot(job) });
		return this.#snapshot(job);
	}

	get(id: string): JobView | undefined {
		const job = this.#jobs.get(id);
		return job === undefined ? undefined : this.#snapshot(job);
	}

	list(): readonly JobView[] {
		return [...this.#jobs.values()]
			.map((job) => this.#snapshot(job))
			.sort((left, right) => right.startedAt - left.startedAt);
	}

	output(id: string): string {
		return this.#jobs.get(id)?.process.output().text ?? "";
	}

	/** 请求终止；返回 undefined 表示没有这个作业，已在运行之外的作业不需要再杀。 */
	kill(id: string): JobView | undefined {
		const job = this.#jobs.get(id);
		if (job === undefined) return undefined;
		if (job.info.status === "running") {
			job.killRequested = true;
			job.process.kill();
		}
		return this.#snapshot(job);
	}

	/** 非阻塞读取，或最多等待 timeoutMs；超时仍返回当前状态。 */
	async wait(id: string, timeoutMs: number): Promise<JobView | undefined> {
		const job = this.#jobs.get(id);
		if (job === undefined) return undefined;
		if (job.info.status !== "running" || timeoutMs <= 0) return this.#snapshot(job);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		});
		await Promise.race([job.done, timeout]);
		if (timer !== undefined) clearTimeout(timer);
		return this.#snapshot(job);
	}

	subscribe(listener: (event: JobEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 退出时收起所有子进程，避免留下孤儿进程。 */
	shutdown(): void {
		for (const job of this.#jobs.values()) {
			if (job.info.status !== "running") continue;
			job.killRequested = true;
			job.process.kill();
		}
	}

	#snapshot(job: ActiveJob): JobView {
		return {
			...job.info,
			overflowed: job.process.overflowed(),
		};
	}

	#prune(): void {
		const finished = [...this.#jobs.values()]
			.filter((job) => job.info.status !== "running")
			.sort((left, right) => (right.info.endedAt ?? 0) - (left.info.endedAt ?? 0));
		for (const job of finished.slice(COMPLETED_LIMIT)) this.#jobs.delete(job.info.id);
	}

	#emit(event: JobEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// 界面的异常不能影响进程回收
			}
		}
	}
}

const JOB_OUTPUT_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "The job id returned by bash with background:true." },
		waitMs: {
			type: "integer",
			minimum: 0,
			description:
				"Wait up to this many milliseconds for completion (clamped to 60000); 0 or omitted returns a snapshot.",
		},
	},
	required: ["id"],
} as const satisfies JsonSchema;

type JobOutputArgs = {
	readonly id: string;
	readonly waitMs?: number;
};

/** 读取后台作业状态与输出。 */
export function createJobOutputTool(jobs: JobManager): ToolDefinition<JobOutputArgs> {
	return {
		name: "job_output",
		summary: "Read a background job's status and output",
		description:
			"Read the status and accumulated output of a background job. Omit waitMs (or use 0) for a " +
			"non-blocking snapshot; a positive waitMs waits for completion up to 60 seconds. A job that is " +
			"still running after the wait is left running.",
		parameters: JOB_OUTPUT_PARAMETERS,
		annotations: { readOnly: true, destructive: false, openWorld: false },

		async execute({ args }): Promise<ToolResult> {
			const job = await jobs.wait(args.id, Math.min(Math.max(0, args.waitMs ?? 0), 60_000));
			if (job === undefined) {
				return { content: `Unknown background job: ${args.id}`, isError: true };
			}
			const output = jobs.output(args.id);
			const elapsed = (job.endedAt ?? Date.now()) - job.startedAt;
			const header = [
				`Job ${job.id} · ${job.status}`,
				formatDuration(elapsed),
				job.command,
			].join(" · ");
			const notes: string[] = [];
			if (job.status === "running" && (args.waitMs ?? 0) > 0) notes.push("[still running after the wait]");
			if (job.timedOut === true) notes.push("[killed after the timeout]");
			if (job.exitCode !== undefined && job.exitCode !== null) {
				notes.push(`[exit code ${job.exitCode}]`);
			}
			if (job.overflowed === true) notes.push("[earlier output was dropped after the buffer filled]");

			const body =
				output.length === 0
					? "[no output yet]"
					: (() => {
							const truncated = truncateTail(output, DEFAULT_LIMITS);
							return truncated.truncated
								? `[showing the end of the output, ${truncated.totalLines} lines total]\n${truncated.text}`
								: truncated.text;
						})();
			return {
				content: [header, ...notes, "", body].join("\n"),
				details: { jobId: job.id, status: job.status },
			};
		},
	};
}

const KILL_JOB_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "The job id returned by bash with background:true." },
	},
	required: ["id"],
} as const satisfies JsonSchema;

type KillJobArgs = {
	readonly id: string;
};

/** 终止后台作业。 */
export function createKillJobTool(jobs: JobManager): ToolDefinition<KillJobArgs> {
	return {
		name: "kill_job",
		summary: "Stop a background job",
		description: "Ask a background job to stop and kill its process tree. Already-finished jobs are left alone.",
		parameters: KILL_JOB_PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: false },

		async execute({ args }): Promise<ToolResult> {
			const job = jobs.kill(args.id);
			if (job === undefined) {
				return { content: `Unknown background job: ${args.id}`, isError: true };
			}
			return {
				content:
					job.status === "running"
						? `Stopping background job ${job.id}: ${job.command}`
						: `Background job ${job.id} is already ${job.status}.`,
				details: { jobId: job.id, status: job.status },
			};
		},
	};
}
