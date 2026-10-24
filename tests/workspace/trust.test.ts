import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	findProjectResources,
	findSavedDecision,
	readTrustedRoots,
	resolveTrust,
} from "../../src/workspace/trust.ts";

const created: string[] = [];

function tempWorkspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-trust-"));
	created.push(directory);
	return directory;
}

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("工作区里的受保护资源", () => {
	it("什么都没有时不列任何东西", () => {
		const root = tempWorkspace();

		assert.deepEqual(findProjectResources(root).files, []);
		assert.deepEqual(findProjectResources(root).skillDirectories, []);
	});

	it("项目级 AGENTS.md / CLAUDE.md 也是受保护资源", () => {
		const root = tempWorkspace();
		writeFileSync(join(root, "AGENTS.md"), "use npm test", "utf8");
		writeFileSync(join(root, "CLAUDE.md"), "use tabs", "utf8");

		assert.deepEqual(findProjectResources(root).files, [
			join(root, "AGENTS.md"),
			join(root, "CLAUDE.md"),
		]);

		writeFileSync(join(root, "AGENTS.override.md"), "override", "utf8");
		assert.deepEqual(findProjectResources(root).files, [
			join(root, "AGENTS.override.md"),
			join(root, "AGENTS.md"),
			join(root, "CLAUDE.md"),
		]);
	});

	it("项目级技能目录同样需要信任，两个位置都算", () => {
		const root = tempWorkspace();
		mkdirSync(join(root, ".reins", "skills"), { recursive: true });
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });

		const resources = findProjectResources(root);
		assert.deepEqual(resources.skillDirectories, [
			join(root, ".reins", "skills"),
			join(root, ".agents", "skills"),
		]);
	});

	it("技能是文件而不是目录时不算数", () => {
		const root = tempWorkspace();
		mkdirSync(join(root, ".agents"), { recursive: true });
		writeFileSync(join(root, ".agents", "skills"), "", "utf8");

		assert.deepEqual(findProjectResources(root).skillDirectories, []);
	});
});

describe("信任清单匹配", () => {
	it("目录本身与祖先目录建立的信任被子目录继承", () => {
		const roots = ["E:\\w"];
		assert.equal(findSavedDecision(roots, "E:\\w"), true);
		assert.equal(findSavedDecision(roots, "E:\\w\\sub\\deeper"), true);
	});

	it("子目录的信任不反哺祖先", () => {
		assert.equal(findSavedDecision(["E:\\w\\sub"], "E:\\w"), undefined);
	});

	it("清单里没有匹配时返回 undefined", () => {
		assert.equal(findSavedDecision(["E:\\other"], "E:\\w"), undefined);
		assert.equal(findSavedDecision([], "E:\\w"), undefined);
	});
});

describe("信任决议", () => {
	it("没有需要保护的资源时按不信任", async () => {
		const decision = await resolveTrust({ root: "E:\\w", override: undefined, trustedRoots: [], hasProtectedResources: false });
		assert.deepEqual(decision, { trusted: false, source: "none" });
	});

	it("命令行给出的一票优先", async () => {
		const trusted = await resolveTrust({ root: "E:\\w", override: true, trustedRoots: [], hasProtectedResources: true });
		assert.deepEqual(trusted, { trusted: true, source: "flag" });

		const denied = await resolveTrust({ root: "E:\\w", override: false, trustedRoots: [], hasProtectedResources: true });
		assert.deepEqual(denied, { trusted: false, source: "flag" });
	});

	it("已记录的清单次之", async () => {
		const decision = await resolveTrust({
			root: "E:\\w",
			override: undefined,
			trustedRoots: ["E:\\w"],
			hasProtectedResources: true,
		});
		assert.deepEqual(decision, { trusted: true, source: "saved" });
	});

	it("没有命令行结论与记录时默认不信任", async () => {
		const decision = await resolveTrust({ root: "E:\\w", override: undefined, trustedRoots: [], hasProtectedResources: true });
		assert.deepEqual(decision, { trusted: false, source: "default" });
	});
});

describe("读信任清单", () => {
	it("非数组或混入非字符串时只留字符串", () => {
		assert.deepEqual(readTrustedRoots(["/a", 1, null, "/b"]), ["/a", "/b"]);
		assert.deepEqual(readTrustedRoots("x"), []);
		assert.deepEqual(readTrustedRoots(undefined), []);
	});
});
