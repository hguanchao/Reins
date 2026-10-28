import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBuiltinCommands } from "../../../src/tui/commands.ts";
import { updateCommandMenu } from "../../../src/tui/runtime/panels.ts";
import type { TuiHost, TuiState } from "../../../src/tui/runtime/types.ts";
import type { TuiOptions } from "../../../src/tui/options.ts";

function stateOf(input: string): TuiState {
	return {
		input,
		commandMenuDismissed: false,
		approvalPrompt: undefined,
		modelMenu: undefined,
		effortMenu: undefined,
		sessionMenu: undefined,
		commandMenu: undefined,
	} as TuiState;
}

function hostOf(state: TuiState): TuiHost {
	const commands = createBuiltinCommands({} as TuiOptions);
	return { state, commands: () => commands } as TuiHost;
}

describe("命令补全的隐藏项", () => {
	it("只输入斜杠时不列隐藏命令", () => {
		const state = stateOf("/");
		updateCommandMenu(hostOf(state));
		assert.deepEqual(
			state.commandMenu?.items.map((item) => item.name),
			["model", "effort", "compact", "plan", "session", "help", "undo", "skills", "mcps"],
		);
	});

	it("完整输入隐藏命令名时才出现", () => {
		const state = stateOf("/jobs");
		updateCommandMenu(hostOf(state));
		assert.deepEqual(
			state.commandMenu?.items.map((item) => item.name),
			["jobs"],
		);
	});

	it("隐藏命令的前缀不会把它带出来", () => {
		const state = stateOf("/jo");
		updateCommandMenu(hostOf(state));
		assert.deepEqual(state.commandMenu?.items, []);
	});
});
