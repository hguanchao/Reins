import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FAILURE_ACTIONS,
	NO_MODELS,
	STATUS,
	alwaysAllowFile,
	alwaysAllowScope,
	cancelPhrase,
	countSegments,
	failure,
	hiddenLines,
	queuedOverflow,
	reviewBlocks,
	subagentLabel,
	subagentMetric,
	taskLabel,
	toolGroupSummary,
	waitForTurn,
} from "../../src/tui/copy.ts";

describe("界面文案", () => {
	it("中断说明先分类再出句子，拿不到原因时保持中性", () => {
		assert.equal(cancelPhrase("user"), "Turn stopped by you");
		assert.equal(cancelPhrase("session"), "Turn stopped because the session closed");
		// 没有标记时不能说成是使用者停的：那是在替使用者编造事实
		assert.equal(cancelPhrase(undefined), "Turn stopped");
		assert.equal(cancelPhrase(undefined).includes("you"), false);
	});

	it("不可用与等待回合的句式只有一种写法", () => {
		assert.equal(waitForTurn("/plan"), "/plan: wait for the running turn to finish");
		assert.equal(waitForTurn("Forking"), "Forking: wait for the running turn to finish");
		assert.equal(reviewBlocks("/export"), "/export: a review is running, try again when it ends");
		assert.equal(STATUS.planUnavailable, "Plan mode isn't available in this session");
		assert.equal(STATUS.exportUnavailable, "Session export isn't available in this session");
	});

	it("失败一律以 Error: 开头，动作名只有一份", () => {
		assert.equal(failure(FAILURE_ACTIONS.undo, "git not found"), "Error: undo failed · git not found");
		assert.equal(failure(FAILURE_ACTIONS.sessionFork, "no storage"), "Error: session fork failed · no storage");
	});

	it("计数与省略行按单复数拼接", () => {
		assert.equal(toolGroupSummary({ read: 1, list: 1, search: 0, command: 0 }), "Read 1 file, Listed 1 folder");
		assert.equal(toolGroupSummary({ read: 2, list: 0, search: 2, command: 1 }), "Read 2 files, Searched 2 patterns, Ran 1 command");
		assert.equal(toolGroupSummary({ read: 0, list: 0, search: 0, command: 0 }), "");
		assert.equal(countSegments({ running: 1, done: 2 }), "1 running · 2 done");
		assert.equal(hiddenLines(3), "… (3 more lines)");
		assert.equal(hiddenLines(3, "Ctrl+G"), "… (3 more lines · Ctrl+G)");
	});

	it("标签与统计段留出词间空格", () => {
		assert.equal(subagentLabel(1), "Subagent 1");
		assert.equal(taskLabel(3), "Task 3");
		// 只有步数、只有耗时、两者都有，都不该把括号丢掉或多出空段
		assert.equal(subagentMetric(2, undefined), " (2 steps)");
		assert.equal(subagentMetric(undefined, 1000), " (1.0s)");
		assert.equal(subagentMetric(1, 1000), " (1 step · 1.0s)");
		assert.equal(subagentMetric(undefined, undefined), "");
	});

	it("队列与空态句不写成分号堆叠", () => {
		assert.equal(queuedOverflow(3, 2), "3 messages queued · showing the first 2");
		assert.equal(NO_MODELS, "No models configured · add one to providers.json");
	});

	it("审批动作写清允许的范围，文件类不重复路径", () => {
		assert.equal(alwaysAllowFile(), "Yes, always allow this file");
		assert.equal(alwaysAllowScope("git status"), 'Yes, always allow "git status"');
	});
});
