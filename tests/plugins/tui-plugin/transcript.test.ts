import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../../src/agent/events.ts";
import { Transcript } from "../../../src/plugins/tui-plugin/transcript.ts";

function texts(lines: readonly (readonly { readonly text: string }[])[]): string[] {
	// 模型产出的行带缩进，断言关心的是内容本身，因此比较时把两端空白去掉
	return lines.map((line) => line.map((span) => span.text).join("")).map((line) => line.trim());
}

const NOW = 1_000_000;

describe("会话显示状态", () => {
	it("回显我说的话，长句子折行后缩进对齐", () => {
		const transcript = new Transcript(12);
		assert.deepEqual(texts(transcript.userTurn("一二三四五六七八九十")), ["› 一二三四", "五六七八", "九十"]);
	});

	it("流式回答按 markdown 画在活动块里", () => {
		const transcript = new Transcript(40);
		transcript.handle({ type: "text_delta", text: "# 标题\n\n正文" }, NOW);
		assert.deepEqual(texts(transcript.live({ maxLines: 10, now: NOW })), ["标题", "", "正文"]);
	});

	it("还在写的回答不产生已定型的行，只在活动块里", () => {
		const transcript = new Transcript(20);
		transcript.handle({ type: "text_delta", text: "一二三四五六七八九十" }, NOW);
		// 写到一半的内容随时会重排，因此不算定型；整屏绘制由调用方自己决定显示哪一段
		assert.deepEqual(transcript.handle({ type: "text_delta", text: "又写了" }, NOW), []);
		assert.ok(transcript.live({ now: NOW }).length > 0);
	});

	it("不传 maxLines 时活动块不折叠：显示哪一段由调用方自己挑", () => {
		const transcript = new Transcript(10);
		transcript.handle({ type: "text_delta", text: "第一段\n\n第二段\n\n第三段" }, NOW);
		const lines = transcript.live({ now: NOW });
		assert.equal(lines.length, 5);
		assert.deepEqual(texts(lines), ["第一段", "", "第二段", "", "第三段"]);
	});

	it("调工具之前先把写好的回答交出去", () => {
		const transcript = new Transcript(40);
		transcript.handle({ type: "text_delta", text: "先看看文件。" }, NOW);
		const lines = transcript.handle(
			{ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } },
			NOW,
		);
		assert.deepEqual(texts(lines), ["先看看文件。"]);
		assert.deepEqual(texts(transcript.live({ maxLines: 5, now: NOW })).length, 1);
	});

	it("工具跑的时候显示成带指示器的一行，参数过长会截断", () => {
		const transcript = new Transcript(120);
		transcript.handle(
			{ type: "tool_start", callId: "c1", name: "bash", args: { command: "x".repeat(200) } },
			NOW,
		);
		const live = texts(transcript.live({ maxLines: 5, now: NOW }));
		assert.equal(live.length, 1);
		assert.ok(live[0].includes("bash"));
		assert.ok(live[0].includes("…"));
	});

	it("工具的阶段性输出显示成最后一行", () => {
		const transcript = new Transcript(80);
		transcript.handle({ type: "tool_start", callId: "c1", name: "bash", args: {} }, NOW);
		transcript.handle({ type: "tool_update", callId: "c1", text: "第一行\n第二行" }, NOW);
		assert.ok(texts(transcript.live({ maxLines: 5, now: NOW }))[0].includes("第二行"));
	});

	it("工具结束时交出一行结果，成功与失败各自成文", () => {
		const transcript = new Transcript(80);
		transcript.handle({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } }, NOW);
		const ok = transcript.handle(
			{ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 12, summary: "内容" },
			NOW + 12,
		);
		assert.deepEqual(texts(ok), ["✓ read {\"path\":\"a.ts\"} 12ms"]);

		transcript.handle({ type: "tool_start", callId: "c2", name: "bash", args: { command: "ls" } }, NOW);
		const failed = transcript.handle(
			{ type: "tool_end", callId: "c2", name: "bash", isError: true, durationMs: 5, summary: "没这条命令" },
			NOW,
		);
		assert.deepEqual(texts(failed), ['✗ bash {"command":"ls"} 失败 5ms：没这条命令']);
	});

	it("推理内容只做预览，不写进滚动区", () => {
		const transcript = new Transcript(30);
		transcript.handle({ type: "reasoning_delta", text: "想一想\n再想一想" }, NOW);
		assert.deepEqual(texts(transcript.live({ maxLines: 5, now: NOW })), ["·     想一想", "再想一想"]);

		// 本轮结束时推理内容被丢掉
		assert.deepEqual(texts(transcript.flush()), []);
		assert.deepEqual(transcript.live({ maxLines: 5, now: NOW }), []);
	});

	it("活动块超出上限时丢掉上面的部分并留一个记号", () => {
		const transcript = new Transcript(10);
		transcript.handle({ type: "reasoning_delta", text: "推理" }, NOW);
		transcript.handle({ type: "text_delta", text: "一二三四五六七八九十" }, NOW);

		// 推理一行加回答两行压到两行：丢掉最上面那行，留一个记号提示
		const live = texts(transcript.live({ maxLines: 2, now: NOW }));
		assert.deepEqual(live, ["…", "十"]);
	});

	it("中止与出错都会留下明确的一行", () => {
		const transcript = new Transcript(40);
		assert.deepEqual(texts(transcript.handle({ type: "aborted" }, NOW)), ["已中止"]);
		assert.deepEqual(texts(transcript.handle({ type: "error", message: "连接断了" }, NOW)), ["出错：连接断了"]);
	});

	it("本轮结束时把剩下的回答交出去", () => {
		const transcript = new Transcript(20);
		transcript.handle({ type: "text_delta", text: "答案在这里" }, NOW);
		assert.deepEqual(texts(transcript.handle({ type: "run_end" }, NOW)), ["答案在这里"]);
		assert.deepEqual(transcript.live({ maxLines: 5, now: NOW }), []);
		// 再交一次不会重复
		assert.deepEqual(transcript.flush(), []);
	});

	it("中断后正在跑的工具不再留在活动块里", () => {
		const transcript = new Transcript(40);
		transcript.handle({ type: "tool_start", callId: "c1", name: "bash", args: {} }, NOW);
		transcript.clearRunning();
		assert.deepEqual(transcript.live({ maxLines: 5, now: NOW }), []);
	});

	it("换宽度后重新排版", () => {
		const transcript = new Transcript(20);
		transcript.handle({ type: "text_delta", text: "一二三四五六七八九十" }, NOW);
		// 20 列扣掉 4 列缩进还剩 16 列，十个汉字折成两行
		assert.equal(texts(transcript.live({ maxLines: 10, now: NOW })).length, 2);

		transcript.resize(8);
		assert.equal(texts(transcript.live({ maxLines: 10, now: NOW })).length, 5);
	});

	it("压缩上下文时说明为什么停下来，结束与失败各留一行", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "text_delta", text: "先说到这。" }, NOW);

		// 开始压缩前先把写好的回答交出去：它会等到摘要写完，留在活动块里看起来像卡住了
		const started = transcript.handle({ type: "compaction_start", messages: 12, tokensBefore: 9000 }, NOW);
		assert.deepEqual(texts(started), [
			"先说到这。",
			"上下文偏长，正在把前面 12 条换成摘要（约 9000 token）",
		]);

		const ended = transcript.handle(
			{ type: "compaction_end", covered: 12, tokensBefore: 9000, tokensAfter: 800 },
			NOW,
		);
		assert.ok(texts(ended)[0].includes("已压缩上下文"));
		assert.ok(texts(ended)[0].includes("历史仍在会话文件里"));

		assert.ok(
			texts(transcript.handle({ type: "compaction_failed", message: "端点连不上" }, NOW))[0].includes(
				"压缩没有成功",
			),
		);
	});
});

describe("工具调用的参数摘要", () => {
	it("空参数不显示，长参数截断", () => {
		const transcript = new Transcript(200);
		transcript.handle({ type: "tool_start", callId: "a", name: "ls", args: {} }, NOW);
		assert.ok(!texts(transcript.live({ maxLines: 5, now: NOW }))[0].includes("{}"));

		transcript.handle({ type: "tool_start", callId: "b", name: "read", args: { path: "x".repeat(100) } }, NOW);
		const line = texts(transcript.live({ maxLines: 5, now: NOW }))[1];
		assert.ok(line.includes("…"));
		assert.ok(line.length < 120);
	});
});

describe("事件的未知类型", () => {
	it("阶段信号不产生任何内容", () => {
		const transcript = new Transcript(20);
		const events: AgentEvent[] = [
			{ type: "turn_start" },
			{ type: "turn_end", stopReason: "stop" },
		];
		for (const event of events) assert.deepEqual(transcript.handle(event, NOW), []);
	});
});
