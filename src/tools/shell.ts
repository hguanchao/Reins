import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * shell 进程的公共部分。
 *
 * 前台 bash 与后台作业共享同一套 shell 选择、输出收集与进程树终止规则；两边各写一遍，
 * 迟早在 Windows 的进程组或编码上分叉。这里只负责起进程与收输出，工具语义留在 bash。
 */

export interface Shell {
	readonly command: string;
	readonly args: (command: string) => string[];
	/** 额外注入的环境变量；使用者自己的环境优先 */
	readonly env: Readonly<Record<string, string>>;
}

/** resolveShell 的输入来源；抽出来是为了在非 Windows 上也能测试 Windows 的分支。 */
export interface ShellLookup {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly exists: (path: string) => boolean;
	/** 返回 PATH 上所有同名可执行文件，按查找顺序排列 */
	readonly which: (name: string) => readonly string[];
}

/** 累积输出的上限。超出部分拿不回来，但必须告诉调用方，否则它会以为这就是全部。 */
export const MAX_CAPTURED_BYTES = 5 * 1024 * 1024;

/**
 * 选 shell。
 *
 * Windows 上工具叫 bash，就必须真的跑 bash：cmd.exe 不理解 `pwd`、`/c/...` 这类写法，
 * 也不保证 UTF-8 输出。优先常见的 Git Bash 安装位置，再查 PATH；WSL 的 bash 采用另一套
 * 路径规则，不能和这里给模型的 POSIX 提示混用，因此跳过。找不到就明确报错，不静默退回 cmd。
 */
export function resolveShell(lookup: ShellLookup = systemLookup(), shellPath?: string): Shell {
	if (shellPath !== undefined) {
		if (!lookup.exists(shellPath)) {
			throw new Error(
				`Configured shellPath not found: ${shellPath}; set shellPath or shell_path in config.toml`,
			);
		}
		return bashShell(shellPath);
	}

	if (lookup.platform !== "win32") {
		return {
			command: lookup.env["SHELL"] ?? "/bin/sh",
			args: (command) => ["-c", command],
			env: {},
		};
	}

	for (const candidate of gitBashCandidates(lookup.env)) {
		if (lookup.exists(candidate)) return bashShell(candidate);
	}

	for (const candidate of lookup.which("bash.exe")) {
		if (!isWslBash(candidate)) return bashShell(candidate);
	}

	throw new Error(
		"No bash found. On Windows Reins runs commands with Git Bash; install Git for Windows, make " +
			"sure bash.exe is on PATH, or set shellPath or shell_path in config.toml. WSL bash is not used.",
	);
}

function bashShell(command: string): Shell {
	return {
		command,
		args: (input) => ["-c", input],
		// 系统代码页输出（中文 Windows 上是 GBK）到 UTF-8 解码会变成乱码；先给解释器一个
		// UTF-8 默认值，使用者自己设置的同名变量仍然优先
		env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8:surrogateescape" },
	};
}

function gitBashCandidates(env: NodeJS.ProcessEnv): readonly string[] {
	const roots = [
		env["ProgramFiles"],
		env["ProgramFiles(x86)"],
		env["LOCALAPPDATA"] === undefined ? undefined : join(env["LOCALAPPDATA"], "Programs"),
	];
	return roots
		.filter((root): root is string => root !== undefined && root.length > 0)
		.map((root) => join(root, "Git", "bin", "bash.exe"));
}

function isWslBash(path: string): boolean {
	const normalized = path.toLowerCase().replaceAll("/", "\\");
	return (
		/\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized) ||
		/\\windowsapps\\bash\.exe$/.test(normalized)
	);
}

function systemLookup(): ShellLookup {
	return {
		platform: process.platform,
		env: process.env,
		exists: (path) => {
			try {
				accessSync(path);
				return true;
			} catch {
				return false;
			}
		},
		which: findOnPath,
	};
}

function findOnPath(name: string): readonly string[] {
	const finder = process.platform === "win32" ? "where.exe" : "which";
	try {
		const result = spawnSync(finder, [name], { encoding: "utf8", timeout: 5000, windowsHide: true });
		if (result.status !== 0 || typeof result.stdout !== "string") return [];
		return result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

export interface ShellExit {
	readonly started: boolean;
	readonly code: number | null;
	/** 被信号终止时的信号名；正常退出为 null。code 为 null 时靠它区分「被杀」与「没有退出码」 */
	readonly signal: string | null;
	readonly reason: string;
}

export interface ShellProcess {
	readonly child: ChildProcess;
	/** 当前累计输出；作业运行中也可以读取快照 */
	output(): { readonly text: string; readonly overflowed: boolean };
	/** 只问是否溢出，不拼接整段输出；Jobs bar 每帧都会读它。 */
	overflowed(): boolean;
	wait(): Promise<ShellExit>;
	kill(): void;
}

export interface StartShellProcessInput {
	readonly shell: Shell;
	readonly command: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly maxBytes?: number;
}

/** 启动一个 shell 进程；调用方负责超时与中止，kill 会连同子进程一起结束。 */
export function startShellProcess(input: StartShellProcessInput): ShellProcess {
	const child = spawn(input.shell.command, input.shell.args(input.command), {
		cwd: input.cwd,
		env: input.env,
		// 自成进程组，超时或中止时才能把命令带出来的子进程一起结束
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const collector = new OutputCollector(child, input.maxBytes ?? MAX_CAPTURED_BYTES);
	return {
		child,
		output: () => ({ text: collector.text(), overflowed: collector.overflowed }),
		overflowed: () => collector.overflowed,
		wait: () => waitForExit(child),
		kill: () => killProcessTree(child),
	};
}

/**
 * 收集合并后的输出。
 *
 * 标准输出与标准错误合在一起：对使用者的判断来说，命令「报了什么」比「从哪个流报的」更重要，
 * 分两段显示反而要来回对照。超过上限后停止累积，只记下发生过溢出。
 */
class OutputCollector {
	readonly #chunks: Buffer[] = [];
	readonly #maxBytes: number;
	#kept = 0;
	#overflowed = false;

	constructor(child: ChildProcess, maxBytes: number) {
		this.#maxBytes = maxBytes;
		child.stdout?.on("data", (chunk: Buffer) => this.#accept(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.#accept(chunk));
	}

	get overflowed(): boolean {
		return this.#overflowed;
	}

	text(): string {
		return sanitizeOutput(Buffer.concat(this.#chunks).toString("utf8"));
	}

	#accept(chunk: Buffer): void {
		if (this.#kept >= this.#maxBytes) {
			this.#overflowed = true;
			return;
		}
		const remaining = this.#maxBytes - this.#kept;
		const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
		if (chunk.length > remaining) this.#overflowed = true;
		this.#chunks.push(slice);
		this.#kept += slice.length;
	}
}

/**
 * 清掉终端转义序列与控制字符。
 *
 * 命令输出会进入模型上下文：颜色码与光标控制对模型没有意义，二进制控制字符还可能破坏
 * 界面与统计。制表、换行、回车保留，它们是正文的一部分。
 */
export function sanitizeOutput(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/**
 * 进程退出后等这么久再判定结束。
 *
 * `close` 要等所有 stdio 都关掉才触发，而命令带出来的孙进程可能还握着管道：进程其实早就
 * 结束了，`close` 却一直不来，调用方于是永远停在「运行中」。`exit` 一到就说明进程没了，
 * 留一个短窗口让残余输出读完即可。
 */
const EXIT_GRACE_MS = 200;

function waitForExit(child: ChildProcess): Promise<ShellExit> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (result: ShellExit): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		child.on("error", (error) => {
			settle({ started: false, code: null, signal: null, reason: error.message });
		});
		// close 的第二个参数是终止信号：被 kill -9、SIGSEGV 或 OOM killer 结束时 code 为 null，
		// 只看 code 会把「被杀」当成「正常结束」。
		child.on("close", (code, signal) => {
			settle({ started: true, code, signal: signal ?? null, reason: "" });
		});
		child.on("exit", (code, signal) => {
			// 正常情况下 close 紧跟着 exit 到来，这个兜底不会生效；只在管道被孙进程占住时兜底
			const timer = setTimeout(() => settle({ started: true, code, signal: signal ?? null, reason: "" }), EXIT_GRACE_MS);
			timer.unref?.();
		});
	});
}

/** 结束进程树失败时的重试间隔与次数：系统繁忙时 taskkill 会短暂失败。 */
const KILL_RETRY_DELAY_MS = 100;
const KILL_ATTEMPTS = 3;

/** 连同命令带出来的子进程一起结束。只杀直接子进程会留下孤儿进程继续占着端口或文件。 */
export function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined) {
		// spawn 是异步的：pid 还没分配时 kill 会抛 EINVAL，直接返回则会让「请求终止」静默
		// 失效——作业一直停在 running，退出清理也留下孤儿进程。等进程真的起来再杀。
		child.once("spawn", () => killProcessTree(child));
		// 起不来的进程没有可杀的东西；消费掉这个事件，避免变成未捕获异常
		child.once("error", () => {});
		return;
	}
	if (process.platform === "win32") {
		taskkillTree(child, KILL_ATTEMPTS);
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		killDirect(child);
	}
}

/**
 * 用 taskkill 结束整棵进程树。
 *
 * taskkill 失败时只给一个非零退出码，不发 error：不看它，「没杀掉」就会被当成「杀掉了」，
 * 作业一直停在 running，退出清理也留下孤儿进程。失败就再试一次——机器繁忙时它偶尔会
 * 打不开进程——最后退回只结束直接子进程。
 *
 * 注意这条退路并不完整：Git Bash 执行一条外部命令时会 fork 出独立的进程（Windows 上
 * 父子关系是真的，但 taskkill 偶尔枚举不到），此时只杀 bash 会留下孙进程继续跑。没有
 * Job Object 之类的系统设施，纯 JS 这一侧拿不到孙进程的 pid，只能靠 taskkill 成功。
 */
function taskkillTree(child: ChildProcess, attemptsLeft: number): void {
	const pid = child.pid;
	if (pid === undefined) return;
	// 用 System32 下的绝对路径，避免 PATH 上有同名程序时杀错东西
	const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");

	const retry = (): void => {
		if (attemptsLeft > 1) setTimeout(() => taskkillTree(child, attemptsLeft - 1), KILL_RETRY_DELAY_MS);
		else killDirect(child);
	};

	let killer: ChildProcess;
	try {
		killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
	} catch {
		killDirect(child);
		return;
	}
	// spawn 失败只会发 error 事件；不消费就会变成未捕获异常
	killer.on("error", retry);
	killer.on("close", (code) => {
		if (code !== 0) retry();
	});
}

/** 只结束直接子进程；杀不掉就算了，调用方已经无从再做什么。 */
function killDirect(child: ChildProcess): void {
	try {
		child.kill("SIGKILL");
	} catch {
		// pid 无效或进程已经退出：没有可杀的东西
	}
}
