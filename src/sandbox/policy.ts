import type { SandboxMode } from "../config/config-file.ts";
import { isPathInside } from "../workspace/boundary.ts";

/**
 * 沙箱接缝与判定。
 *
 * 工具不自己判断「能不能写这个路径」，一律经过这里。把判定留在宿主之后，工具无论来自核心
 * 还是插件都被同一套规则约束，插件也没有机会绕过。
 *
 * 两条规则贯穿全篇：
 * 一、不确定就拒绝。判定不了的情形按不允许处理，而不是放过去。
 * 二、宁可不能用，也不假装可用。模式要求隔离而当前平台做不到时明确报错，绝不退回到不隔离
 *     的执行——那会让使用者以为自己有保护，实际上一点也没有。
 *
 * 这里没有任何具体的隔离实现：操作系统的手段（macOS 的 seatbelt、Linux 的 bubblewrap）
 * 由插件提供。所以「没有后端」是一个正常状态，它的含义就是「当前无法约束命令」。
 */

export interface SandboxView {
	/**
	 * 判定一次文件操作是否被允许。不允许时抛错，错误信息说明是哪条规则挡住的。
	 * 不隔离时不做任何判定。
	 */
	assertPathAllowed(operation: "read" | "write", absolutePath: string): void;

	/**
	 * 把一条 shell 命令包成真正要执行的命令行。
	 *
	 * 返回字符串而不是参数数组，是因为隔离手段本身就是以「另一层命令」的形式套在命令前面，
	 * 最终仍交给 shell 解析。
	 */
	wrapCommand(command: string): string;
}

export interface SandboxPolicy {
	readonly mode: SandboxMode;
	/** 工作区根。工作区模式下只有它之内允许写入。 */
	readonly root: string;
}

/**
 * 平台层面的命令隔离。
 *
 * 路径判定由 Sandbox 自己完成、与平台无关；但一条任意命令能做的事远超几个文件操作，想真正
 * 约束它只能借操作系统的手段。做不到就必须拒绝执行。
 */
export interface SandboxBackend {
	readonly id: string;
	/** 当前平台是否具备这套手段 */
	readonly available: boolean;
	/** 包成受约束的命令；返回 undefined 表示这条命令约束不了 */
	wrap(command: string, policy: SandboxPolicy): string | undefined;
}

export class Sandbox implements SandboxView {
	readonly #policy: SandboxPolicy;
	readonly #backend: SandboxBackend | undefined;

	constructor(policy: SandboxPolicy, backend: SandboxBackend | undefined) {
		this.#policy = policy;
		this.#backend = backend;
	}

	/** 当前模式能否真正约束住任意命令。界面据此提示使用者。 */
	get confinesCommands(): boolean {
		return this.#policy.mode === "off" || this.#backend?.available === true;
	}

	assertPathAllowed(operation: "read" | "write", absolutePath: string): void {
		const { mode, root } = this.#policy;
		if (mode === "off") return;
		// 两种模式限制的都是写入：只读模式什么都不许改，工作区模式只许改工作区里的东西
		if (operation === "read") return;

		if (mode === "read-only") {
			throw new Error(
				`沙箱处于只读模式，不允许写入 ${absolutePath}。要允许写入请调整 config.toml 里的 sandbox。`,
			);
		}
		if (!isPathInside(root, absolutePath)) {
			throw new Error(
				`沙箱限制在工作区内，${absolutePath} 落在了 ${root} 之外，不允许写入。` +
					"确实需要写到外面时，请调整 config.toml 里的 sandbox。",
			);
		}
	}

	wrapCommand(command: string): string {
		if (this.#policy.mode === "off") return command;

		if (this.#backend === undefined || !this.#backend.available) {
			throw new Error(
				`沙箱模式为 ${this.#policy.mode}，但当前平台（${process.platform}）没有可用的隔离手段，` +
					"因此这条命令不会被执行。想在不隔离的前提下运行，请把 config.toml 里的 sandbox 设为 off。",
			);
		}
		const wrapped = this.#backend.wrap(command, this.#policy);
		if (wrapped === undefined) {
			throw new Error(
				`沙箱后端 ${this.#backend.id} 无法约束这条命令，因此它不会被执行。` +
					"想在不隔离的前提下运行，请把 config.toml 里的 sandbox 设为 off。",
			);
		}
		return wrapped;
	}
}
