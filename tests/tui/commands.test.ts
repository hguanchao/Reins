import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBuiltinCommands, findCommand } from "../../src/tui/commands.ts";
import type { TuiOptions } from "../../src/tui/options.ts";

describe("内置斜杠命令", () => {
	const commands = createBuiltinCommands({} as TuiOptions);

	it("补全列表保留工作流命令，其余标记为隐藏", () => {
		assert.deepEqual(
			commands.filter((command) => command.hidden !== true).map((command) => command.name),
			["model", "effort", "compact", "plan", "session", "help", "undo", "skills", "mcps"],
		);
		assert.deepEqual(
			commands.filter((command) => command.hidden === true).map((command) => command.name),
			["rewind", "branches", "export", "review", "checkpoints", "jobs"],
		);
	});

	it("隐藏命令完整输入时仍能查到并执行", () => {
		assert.equal(findCommand("/checkpoints", commands)?.name, "checkpoints");
		assert.equal(findCommand("/jobs", commands)?.name, "jobs");
	});
});
