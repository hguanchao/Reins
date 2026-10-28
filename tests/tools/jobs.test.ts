import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SandboxView } from "../../src/sandbox/policy.ts";
import type { SessionReadView } from "../../src/session/port.ts";
import { createBashTool } from "../../src/tools/builtin/bash.ts";
import {
	createJobOutputTool,
	createKillJobTool,
	JobManager,
	type JobEvent,
} from "../../src/tools/jobs.ts";
import type { WorkspaceBoundary } from "../../src/workspace/boundary.ts";

const WORKSPACE = { root: process.cwd() } as WorkspaceBoundary;
const SANDBOX = { wrapCommand: (command: string) => command } as SandboxView;
const SESSION: SessionReadView = { id: "test-session", path: null };

function manager(): JobManager {
	return new JobManager();
}

describe("后台作业", () => {
	it("启动、等待完成并读取输出", async () => {
		const jobs = manager();
		const events: JobEvent[] = [];
		jobs.subscribe((event) => events.push(event));

		const job = jobs.start({
			command: "printf 'background output\\n'",
			workspace: WORKSPACE,
			sandbox: SANDBOX,
			session: SESSION,
		});
		assert.equal(job.status, "running");

		const done = await jobs.wait(job.id, 5000);
		assert.equal(done?.status, "done");
		assert.equal(done?.exitCode, 0);
		assert.ok(jobs.output(job.id).includes("background output"));
		assert.equal(events[0]?.type, "started");
		assert.ok(events.some((event) => event.type === "finished" && event.job.id === job.id));
		jobs.shutdown();
	});

	it("作业输出工具返回状态与尾部输出，未知 id 报错", async () => {
		const jobs = manager();
		const job = jobs.start({
			command: "printf 'line one\\nline two\\n'",
			workspace: WORKSPACE,
			sandbox: SANDBOX,
			session: SESSION,
		});
		await jobs.wait(job.id, 5000);

		const tool = createJobOutputTool(jobs);
		const result = await tool.execute({ args: { id: job.id } } as never);
		assert.equal(result.isError, undefined);
		assert.match(result.content, /Job j1 · done/);
		assert.ok(result.content.includes("line two"));

		const missing = await tool.execute({ args: { id: "j99" } } as never);
		assert.equal(missing.isError, true);
		assert.match(missing.content, /Unknown background job/);
		jobs.shutdown();
	});

	it("kill 结束进程并落成 killed", async () => {
		const jobs = manager();
		const job = jobs.start({
			// 比等待时间长得多：进程只能因为 kill 结束，避免自然退出与收尾同时发生
			command: "sleep 30",
			workspace: WORKSPACE,
			sandbox: SANDBOX,
			session: SESSION,
		});
		const killed = jobs.kill(job.id);
		assert.equal(killed?.status, "running");
		// 全量测试并行跑时系统很忙，进程树终止可能比预想慢；等待窗口放宽到 15 秒
		const done = await jobs.wait(job.id, 15000);
		assert.equal(done?.status, "killed");

		const tool = createKillJobTool(jobs);
		const result = await tool.execute({ args: { id: job.id } } as never);
		assert.match(result.content, /already killed/);
		jobs.shutdown();
	});

	it("bash 的 background 参数立即返回 job id，前台路径不受影响", async () => {
		const jobs = manager();
		const tool = createBashTool(undefined, jobs);
		const started = await tool.execute({
			args: { command: "printf 'queued\\n'", background: true },
			workspace: WORKSPACE,
			sandbox: SANDBOX,
			session: SESSION,
			signal: new AbortController().signal,
			onUpdate: () => undefined,
		} as never);
		const details = started.details as { readonly jobId?: string; readonly background?: boolean };
		assert.equal(details.background, true);
		assert.match(details.jobId ?? "", /^j\d+$/);
		await jobs.wait(details.jobId ?? "", 5000);
		assert.ok(jobs.output(details.jobId ?? "").includes("queued"));

		const foreground = await tool.execute({
			args: { command: "printf 'foreground\\n'" },
			workspace: WORKSPACE,
			sandbox: SANDBOX,
			session: SESSION,
			signal: new AbortController().signal,
			onUpdate: () => undefined,
		} as never);
		assert.equal(foreground.isError, false);
		assert.ok(foreground.content.includes("foreground"));
		jobs.shutdown();
	});

	it("没有 JobManager 时 background 明确拒绝", async () => {
		const tool = createBashTool();
		const result = await tool.execute({
			args: { command: "printf 'x'", background: true },
			workspace: WORKSPACE,
			sandbox: SANDBOX,
			session: SESSION,
			signal: new AbortController().signal,
			onUpdate: () => undefined,
		} as never);
		assert.equal(result.isError, true);
		assert.match(result.content, /Background jobs are unavailable/);
	});
});
