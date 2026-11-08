import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDesktopPaths, WORKSPACE_NAMES_FILE } from "#desktop/paths.ts";

describe("打包路径", () => {
	it("运行期资源一律相对主进程目录推算，不看当前工作目录", () => {
		const buildDir = join("resources", "app.asar.unpacked", "desktop", "build");
		const paths = createDesktopPaths(buildDir, join("home", "user-data"));
		assert.equal(paths.buildDir, buildDir);
		assert.equal(paths.serverEntry, join(buildDir, "server.mjs"));
		assert.equal(paths.preload, join(buildDir, "preload.cjs"));
		assert.equal(paths.icon, join(buildDir, "icon.ico"));
		assert.equal(paths.uiDist, join(buildDir, "..", "..", "web", "dist"));
	});

	it("userData 下的文件名落到同一目录", () => {
		const paths = createDesktopPaths(join("build"), join("home", "user-data"));
		assert.equal(
			paths.userData(WORKSPACE_NAMES_FILE),
			join("home", "user-data", "workspace-names.json"),
		);
	});
});
