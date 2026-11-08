import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createDesktopPaths } from "#desktop/paths.ts";
import type { ServerHandle, ServerProcess } from "#desktop/server-launch.ts";
import { ServerController, type ServerLauncher } from "#desktop/server-controller.ts";

/** 只实现控制器真正用到的两个能力，测试不依赖真实子进程。 */
interface FakeProcess extends ServerProcess {
	readonly killed: boolean;
	emitExit(code: number | null): void;
}

function fakeProcess(): FakeProcess {
	const emitter = new EventEmitter();
	let killed = false;
	return {
		get killed(): boolean {
			return killed;
		},
		once: (event, listener) => emitter.once(event, listener),
		kill: () => {
			killed = true;
			return true;
		},
		emitExit: (code) => {
			emitter.emit("exit", code);
		},
	};
}

function createHarness(launch: ServerLauncher, loadURL?: (url: string) => Promise<void>) {
	const failures: string[] = [];
	const crashes: string[] = [];
	const remembered: string[] = [];
	const loaded: string[] = [];
	const controller = new ServerController(
		{
			loadURL: async (url: string) => {
				loaded.push(url);
				if (loadURL !== undefined) await loadURL(url);
			},
		},
		createDesktopPaths("build", "user-data"),
		{
			onCrash: (reason) => crashes.push(reason),
			onFailure: (_title, message) => failures.push(message),
			rememberWorkspace: (path) => remembered.push(path),
		},
		launch,
	);
	return { controller, failures, crashes, remembered, loaded };
}

const workspace = process.cwd();

describe("服务进程切换", () => {
	it("加载成功后才提交，并终止被替换的旧进程", async () => {
		const first = fakeProcess();
		const second = fakeProcess();
		let call = 0;
		const harness = createHarness(async () => {
			call += 1;
			const handle: ServerHandle = {
				url: `http://127.0.0.1:${call}/?token=t`,
				child: call === 1 ? first : second,
			};
			return handle;
		});

		assert.equal(await harness.controller.switchTo(workspace, {}, "切换失败"), true);
		assert.equal(harness.controller.origin, "http://127.0.0.1:1");
		assert.notEqual(harness.controller.workspace, undefined);
		assert.equal(harness.remembered.length, 1);
		assert.equal(harness.loaded.length, 1);

		assert.equal(await harness.controller.switchTo(workspace, {}, "切换失败"), true);
		assert.equal(first.killed, true);
		assert.equal(second.killed, false);
		assert.equal(harness.controller.origin, "http://127.0.0.1:2");
		assert.equal(harness.failures.length, 0);
	});

	it("启动失败不改动当前服务，错误上报一次", async () => {
		const harness = createHarness(async () => {
			throw new Error("就绪行超时");
		});
		assert.equal(await harness.controller.switchTo(workspace, {}, "启动失败"), false);
		assert.equal(harness.controller.origin, undefined);
		assert.equal(harness.loaded.length, 0);
		assert.deepEqual(harness.failures, ["就绪行超时"]);
	});

	it("页面加载失败时回滚：新进程被收掉，旧进程继续服务", async () => {
		const first = fakeProcess();
		const second = fakeProcess();
		let call = 0;
		let failLoad = false;
		const harness = createHarness(
			async () => {
				call += 1;
				return { url: `http://127.0.0.1:${call}/?token=t`, child: call === 1 ? first : second };
			},
			async () => {
				if (failLoad) throw new Error("页面加载失败");
			},
		);

		assert.equal(await harness.controller.switchTo(workspace, {}, "切换失败"), true);
		failLoad = true;
		assert.equal(await harness.controller.switchTo(workspace, {}, "切换失败"), false);
		assert.equal(second.killed, true);
		assert.equal(first.killed, false);
		assert.equal(harness.controller.origin, "http://127.0.0.1:1");
		assert.deepEqual(harness.failures, ["页面加载失败"]);
	});

	it("并发切换排队串行，不会同时拉起两个进程", async () => {
		let active = 0;
		let maxActive = 0;
		const harness = createHarness(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
			return { url: "http://127.0.0.1:8787/?token=t", child: fakeProcess() };
		});

		const results = await Promise.all([
			harness.controller.switchTo(workspace, {}, "切换失败"),
			harness.controller.switchTo(workspace, {}, "切换失败"),
			harness.controller.switchTo(workspace, {}, "切换失败"),
		]);
		assert.deepEqual(results, [true, true, true]);
		assert.equal(maxActive, 1);
		assert.equal(harness.loaded.length, 3);
	});

	it("旧进程退出不算崩溃，当前进程退出才上报", async () => {
		const first = fakeProcess();
		const second = fakeProcess();
		let call = 0;
		const harness = createHarness(async () => {
			call += 1;
			return { url: `http://127.0.0.1:${call}/?token=t`, child: call === 1 ? first : second };
		});
		await harness.controller.switchTo(workspace, {}, "切换失败");
		await harness.controller.switchTo(workspace, {}, "切换失败");

		first.emitExit(0);
		assert.equal(harness.crashes.length, 0);
		second.emitExit(1);
		assert.equal(harness.crashes.length, 1);
		assert.match(harness.crashes[0] ?? "", /1/);
	});
});
