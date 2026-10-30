import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	defaultInstructionSources,
	MAX_INSTRUCTION_BYTES,
	readInstructions,
} from "#src/agent/instructions.ts";

const created: string[] = [];
const previousHome = process.env["REINS_HOME"];

function tempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	created.push(directory);
	return directory;
}

/** 每个用例一套独立的用户目录与工作区。 */
function workspace(): { readonly home: string; readonly work: string } {
	const home = tempDir("reins-instructions-home-");
	const work = tempDir("reins-instructions-work-");
	process.env["REINS_HOME"] = home;
	return { home, work };
}

after(() => {
	if (previousHome === undefined) delete process.env["REINS_HOME"];
	else process.env["REINS_HOME"] = previousHome;
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("规则文件发现", () => {
	it("用户规则总是读取，项目规则需要工作区信任", () => {
		const { home, work } = workspace();
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "AGENTS.md"), "user rules", "utf8");
		writeFileSync(join(work, "AGENTS.md"), "project rules", "utf8");

		assert.deepEqual(
			defaultInstructionSources(work, false).map((source) => source.path),
			[join(home, "AGENTS.md")],
		);

		const trusted = defaultInstructionSources(work, true);
		assert.deepEqual(
			trusted.map((source) => source.path),
			[join(home, "AGENTS.md"), join(work, "AGENTS.md")],
		);
		assert.equal(trusted[1]?.label, "AGENTS.md");
	});

	it("AGENTS.override.md 取代同目录的 AGENTS.md 与 CLAUDE.md", () => {
		const { home, work } = workspace();
		mkdirSync(home, { recursive: true });
		for (const directory of [home, work]) {
			writeFileSync(join(directory, "AGENTS.override.md"), "override", "utf8");
			writeFileSync(join(directory, "AGENTS.md"), "agents", "utf8");
			writeFileSync(join(directory, "CLAUDE.md"), "claude", "utf8");
		}

		assert.deepEqual(
			defaultInstructionSources(work, true).map((source) => source.path),
			[join(home, "AGENTS.override.md"), join(work, "AGENTS.override.md")],
		);
	});

	it("没有 AGENTS.md 时回退到 CLAUDE.md", () => {
		const { work } = workspace();
		writeFileSync(join(work, "CLAUDE.md"), "claude rules", "utf8");

		const sources = defaultInstructionSources(work, true);
		assert.deepEqual(
			sources.map((source) => source.path),
			[join(work, "CLAUDE.md")],
		);
		assert.equal(sources[0]?.label, "CLAUDE.md");
	});
});

describe("规则文件读取", () => {
	it("按来源顺序拼接正文，统一换行并跳过空白文件", () => {
		const directory = tempDir("reins-instructions-read-");
		const user = join(directory, "user.md");
		const project = join(directory, "project.md");
		const blank = join(directory, "blank.md");
		writeFileSync(user, "user\r\nrules\r\n", "utf8");
		writeFileSync(project, "project rules", "utf8");
		writeFileSync(blank, "  \n\n", "utf8");

		const entries = readInstructions([
			{ label: "~/.reins/AGENTS.md", path: user },
			{ label: "AGENTS.md", path: project },
			{ label: "blank", path: blank },
		]);

		assert.deepEqual(entries, [
			{ label: "~/.reins/AGENTS.md", text: "user\nrules" },
			{ label: "AGENTS.md", text: "project rules" },
		]);
	});

	it("缺失或读不出来的文件直接跳过，不影响其余规则", () => {
		const directory = tempDir("reins-instructions-missing-");
		const present = join(directory, "present.md");
		writeFileSync(present, "present", "utf8");

		const entries = readInstructions([
			{ label: "missing", path: join(directory, "missing.md") },
			{ label: "present", path: present },
			{ label: "directory", path: directory },
		]);

		assert.deepEqual(entries, [{ label: "present", text: "present" }]);
	});

	it("超过总预算时截断，并明确标注", () => {
		const directory = tempDir("reins-instructions-large-");
		const large = join(directory, "AGENTS.md");
		writeFileSync(large, `${"a".repeat(MAX_INSTRUCTION_BYTES)}TAIL`, "utf8");

		const entries = readInstructions([{ label: "AGENTS.md", path: large }]);
		const text = entries[0]?.text ?? "";

		assert.ok(text.startsWith("a".repeat(MAX_INSTRUCTION_BYTES)));
		assert.ok(text.includes("instructions truncated at 32 KB"));
		assert.equal(text.includes("TAIL"), false);
	});
});
