import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { copyText } from "#src/tui/runtime/copy.ts";
import type { TuiOutput } from "#src/tui/options.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";

interface FakeHostOptions {
	/** 系统剪贴板是否写得进去；默认成功。 */
	readonly clipboard?: () => Promise<boolean>;
	/** 终端输出；默认什么也不做，可以换成写入即抛错来模拟「OSC 52 也走不通」。 */
	readonly stdout?: TuiOutput;
}

/** 最小宿主：记录状态行写了什么，渲染计数只用于确认刷新发生。 */
function fakeHost(
	state: TuiState,
	options: FakeHostOptions = {},
): TuiHost & { readonly renders: number; readonly statuses: string[] } {
	let renders = 0;
	const statuses: string[] = [];
	if (options.stdout !== undefined) {
		(state as unknown as { stdout: TuiOutput }).stdout = options.stdout;
	}
	return {
		state,
		renders: 0 as unknown as number,
		options: { clipboard: { copy: options.clipboard ?? (async () => true) } },
		setStatus: (text: string) => {
			statuses.push(text);
		},
		scheduleStatusClear: () => {},
		render: () => {
			renders += 1;
		},
		statuses,
	} as unknown as TuiHost & { readonly renders: number; readonly statuses: string[] };
}

function freshState(): TuiState {
	return {
		// OSC 52 要往终端写序列：默认给一个能接住的替身，需要时再换成会抛错的
		stdout: { write: () => true } as unknown as TuiOutput,
		statusText: undefined,
		statusTone: undefined,
		statusClearTimer: undefined,
		copyNotice: undefined,
		copyNoticeTimer: undefined,
	} as unknown as TuiState;
}

describe("复制提示的单一来源", () => {
	it("状态行空闲时复制：提示只占 token 位，不再写左侧状态文字", async (t) => {
		const state = freshState();
		const host = fakeHost(state);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await copyText(host, "hello");
		assert.equal(state.copyNotice, "Copied!");
		assert.equal(state.statusText, undefined);
	});

	it("连续复制只留最后一次的提示与字数", async (t) => {
		const state = freshState();
		const host = fakeHost(state);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await copyText(host, "first");
		await copyText(host, "second");
		assert.equal(state.copyNotice, "Copied!");
	});

	it("上一次状态清理的计时器不再吞掉本次提示", async (t) => {
		const state = freshState();
		const host = fakeHost(state);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		// 模拟回合状态带着一个未到期的自动清理计时器
		state.statusText = "Working";
		state.statusTone = undefined;
		state.statusClearTimer = setTimeout(() => {}, 60_000) as unknown as ReturnType<typeof setTimeout>;
		await copyText(host, "hello");
		assert.equal(state.copyNotice, "Copied!");
		// 旧计时器已被取消，提示不会被它提前清掉
		assert.equal(state.statusClearTimer, undefined);
		assert.notEqual(state.copyNoticeTimer, undefined);
	});
});

describe("复制失败时的落盘兜底", () => {
	it("剪贴板与 OSC 52 都失败时把内容写到文件，并给出路径", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "reins-copy-"));
		const file = join(dir, "last-copy.txt");
		process.env["REINS_COPY_FILE"] = file;
		t.after(() => {
			delete process.env["REINS_COPY_FILE"];
			rmSync(dir, { recursive: true, force: true });
		});

		const state = freshState();
		const host = fakeHost(state, {
			clipboard: async () => false,
			// 终端写入即抛错：OSC 52 也走不通
			stdout: {
				write: () => {
					throw new Error("no terminal");
				},
			} as unknown as TuiOutput,
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });

		await copyText(host, "中文内容");
		assert.equal(readFileSync(file, "utf8"), "中文内容");
		assert.equal(host.statuses.length, 1);
		assert.ok(host.statuses[0]?.includes("Clipboard unavailable · saved to"));
		// 内容没进剪贴板，就不该再显示「已复制」
		assert.equal(state.copyNotice, undefined);
	});

	it("OSC 52 接住了就不额外写文件", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "reins-copy-"));
		const file = join(dir, "last-copy.txt");
		process.env["REINS_COPY_FILE"] = file;
		t.after(() => {
			delete process.env["REINS_COPY_FILE"];
			rmSync(dir, { recursive: true, force: true });
		});

		const state = freshState();
		const host = fakeHost(state, { clipboard: async () => false });
		t.mock.timers.enable({ apis: ["setTimeout"] });

		await copyText(host, "hello");
		assert.equal(state.copyNotice, "Copy sent to terminal");
		assert.throws(() => readFileSync(file, "utf8"));
	});
});
