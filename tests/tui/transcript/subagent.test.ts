import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEME } from "#src/tui/render/theme.ts";
import { displayWidth } from "#src/tui/render/text.ts";
import { buildTranscriptView, renderTranscriptView, stripTerminalStyles, toggleLastExpandable } from "#src/tui/transcript.ts";
import type { TranscriptSubagentGroup, TranscriptTurn } from "#src/tui/transcript.ts";



describe("子代理组", () => {
	type GroupMember = {
		callId: string;
		task: string;
		status: "running" | "done" | "failed";
		durationMs?: number;
		steps?: number;
		totalTokens?: number;
		failure?: string;
	};
	const group = (
		overrides: Partial<{ members: GroupMember[]; startedAt: number; expanded: boolean }> = {},
	): TranscriptSubagentGroup => ({
		kind: "subagentGroup",
		members: (overrides.members ?? [
			{ callId: "1", task: "梳理 tools 模块", status: "done", durationMs: 14_300, steps: 12, totalTokens: 4100 },
			{ callId: "2", task: "检查测试场景", status: "running" },
			{ callId: "3", task: "修复路径", status: "failed", durationMs: 22_600, failure: "upstream 500" },
		]) as TranscriptSubagentGroup["members"],
		startedAt: overrides.startedAt ?? Date.now() - 30_000,
		expanded: overrides.expanded ?? false,
	});

	it("收起只有组头一行:计数段与括号耗时", () => {
		const view = buildTranscriptView(60, [{ prompt: "go", response: [group()] }], undefined);
		const text = view.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.ok(text.includes("› Subagents  1 running · 1 done · 1 failed"));
		// 总耗时挂在括号 metric 位
		assert.ok(/\(\d+(m\d+s|\.\ds)\)/.test(text));
		assert.equal(text.includes("Subagent 1"), false);
	});

	it("展开显示四态清单:●完成/转圈运行/×失败/○待办", () => {
		const running = group({
			members: [
				{ callId: "1", task: "梳理 tools 模块", status: "done" as const, durationMs: 14_300, steps: 12 },
				{ callId: "2", task: "检查测试场景", status: "running" as const },
				{ callId: "3", task: "修复路径", status: "failed" as const, durationMs: 22_600, failure: "upstream 500" },
				{ callId: "4", task: "提交功能", status: "running" as const },
			],
		});
		running.expanded = true;
		const view = buildTranscriptView(60, [{ prompt: "go", response: [running] }], undefined);
		const text = view.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.ok(text.includes("◈ Subagents"));
		assert.ok(text.includes("● Subagent 1  梳理 tools 模块"));
		assert.ok(text.includes("Subagent 2  检查测试场景"));
		// 失败行显示任务名,原因不占清单行
		assert.ok(text.includes("× Subagent 3  修复路径"));
		assert.equal(text.includes("upstream 500"), false);
		assert.ok(text.includes("(12 steps · 14.3s)"));
		assert.ok(text.includes("(22.6s)"));
		assert.ok(text.includes("4 running") === false);
	});

	it("失败的清单行双击展开原因色带,耗时隐藏", () => {
		const failed = group({ expanded: true });
		const view = buildTranscriptView(60, [{ prompt: "go", response: [failed] }], undefined);
		// 命中登记在失败行首
		assert.equal(view.subagentFailureRows.length, 1);

		const member = failed.members[2];
		if (member === undefined || member.status !== "failed") throw new Error("expected a failed member");
		member.expanded = true;
		const view2 = buildTranscriptView(60, [{ prompt: "go", response: [failed] }], undefined);
		const lines = view2.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		const headIndex = lines.findIndex((line) => line.includes("× Subagent 3"));
		assert.ok(headIndex >= 0);
		// 展开后:色带里是原因全文,且失败行不再显示耗时
		const band = lines.slice(headIndex + 1).find((line) => line.includes("upstream 500"));
		assert.ok(band !== undefined);
		// 整行失败色:未剥色的行头带失败色码
		assert.ok((view2.lines[headIndex] ?? "").includes(THEME.error));
		assert.equal(lines[headIndex]?.includes("22.6s"), false);
	});

	it("运行中的清单行登记动画,渲染期重建为转圈与扫光", () => {
		const running = group();
		running.expanded = true;
		const view = buildTranscriptView(60, [{ prompt: "go", response: [running] }], undefined);
		assert.equal(view.liveLines.size, 1);

		const animated = renderTranscriptView(view, 16, 0, { spinner: "⠋", sweepPhase: 0.5 });
		const line = animated.find((row) => row.replace(/\x1b\[[0-9;]*m/g, "").includes("Subagent 2")) ?? "";
		const plain = line.replace(/\x1b\[[0-9;]*m\\/g, "");
		assert.ok(plain.includes("⠋"));
		assert.ok((line.match(/\x1b\[38;2;/g) ?? []).length > 1);
	});

	it("计数段顺序固定 running→done→failed,没有的段不显示", () => {
		const onlyDone = group({
			members: [{ callId: "1", task: "t", status: "done" as const, durationMs: 1000 }],
		});
		const view = buildTranscriptView(60, [{ prompt: "go", response: [onlyDone] }], undefined);
		const text = view.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
		assert.ok(text.includes("1 done"));
		assert.ok(!text.includes("running") && !text.includes("failed"));
	});

	it("展开的成员行不超过内容宽度", () => {
		const expanded = group();
		expanded.expanded = true;
		for (const width of [40, 60, 80]) {
			const view = buildTranscriptView(width, [{ prompt: "go", response: [expanded] }], undefined);
			for (const line of view.lines) {
				const visible = displayWidth(stripTerminalStyles(line));
				assert.ok(visible <= width, `width ${width}: ${visible} > ${width}`);
			}
		}
	});

	it("没有耗时的历史组不显示括号统计", () => {
		const restored: TranscriptSubagentGroup = {
			kind: "subagentGroup",
			members: [{ callId: "1", task: "t", status: "done" }],
			startedAt: 0,
			expanded: false,
		};
		const view = buildTranscriptView(60, [{ prompt: "go", response: [restored] }], undefined);
		const text = view.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
		assert.ok(text.includes("1 done"));
		assert.equal(/\(\d+d/.test(text), false);
	});

	it("Ctrl+E 切换最近一个子代理组的展开", () => {
		const g = group();
		const turns: TranscriptTurn[] = [{ prompt: "go", response: [g] }];
		assert.equal(toggleLastExpandable(turns), true);
		assert.equal(g.expanded, true);
		assert.equal(toggleLastExpandable(turns), true);
		assert.equal(g.expanded, false);
	});
});
