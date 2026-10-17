import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	matchSlashCommands,
	slashContext,
	type SlashCommand,
} from "../../../src/plugins/tui-plugin/slash-menu.ts";

const COMMANDS: readonly SlashCommand[] = [
	{ name: "help", description: "Show help", insertText: "/help" },
	{ name: "exit", description: "Quit", insertText: "/exit" },
	{ name: "notify", description: "Notifications", insertText: "/notify " },
	{ name: "trust", description: "Workspace trust", insertText: "/trust " },
];

describe("斜杠上下文", () => {
	it("只在光标位于命令名内时打开", () => {
		assert.deepEqual(slashContext("/he", 3), { query: "he", tokenLength: 3 });
		assert.deepEqual(slashContext("/he", 1), { query: "", tokenLength: 3 });
		assert.deepEqual(slashContext("/help ", 5), { query: "help", tokenLength: 5 });
		assert.equal(slashContext("/help ", 6), undefined, "cursor after the space is args mode");
		assert.equal(slashContext("/help now", 9), undefined);
		assert.equal(slashContext("hello", 5), undefined);
		assert.equal(slashContext("", 0), undefined);
	});

	it("命令名取到光标位置，替换范围包含光标后的剩余命令名", () => {
		assert.deepEqual(slashContext("/he|lp", 3), { query: "he", tokenLength: 6 });
	});
});

describe("斜杠命令匹配", () => {
	it("空查询保持注册顺序", () => {
		assert.deepEqual(
			matchSlashCommands(COMMANDS, "").map((command) => command.name),
			["help", "exit", "notify", "trust"],
		);
	});

	it("精确、前缀、子序列依次排序，同档短名字优先", () => {
		const commands: readonly SlashCommand[] = [
			{ name: "help", description: "", insertText: "/help" },
			{ name: "heap", description: "", insertText: "/heap" },
			{ name: "shell", description: "", insertText: "/shell" },
			{ name: "he", description: "", insertText: "/he" },
		];
		assert.deepEqual(
			matchSlashCommands(commands, "he").map((command) => command.name),
			["he", "help", "heap", "shell"],
		);
	});

	it("大小写不敏感，匹配不到时返回空", () => {
		assert.deepEqual(
			matchSlashCommands(COMMANDS, "HE").map((command) => command.name),
			["help"],
		);
		assert.deepEqual(matchSlashCommands(COMMANDS, "zzz"), []);
	});
});
