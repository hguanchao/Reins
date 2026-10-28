import {
	defaultInstructionSources,
	readInstructions,
	type PromptInstruction,
} from "../agent/instructions.ts";
import { PermissionGate, PermissionPolicy } from "../permission/policy.ts";
import { TerminalManager } from "../tools/terminal.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { readVersion } from "../version.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { loadSelection } from "./config-selection.ts";
import { initializeConfig } from "./initialize-config.ts";
import { writeStderr, writeStdout } from "./output.ts";
import {
	assemblePipeline,
	createCompactor,
	createDriverFor,
	createReviewer,
} from "./pipeline.ts";
import { runPrintMode } from "./print-mode.ts";
import { createSessionFor } from "./session/factory.ts";
import { runTuiMode } from "./tui-mode.ts";

/**
 * 运行时装配入口。
 *
 * 参数解析只决定运行模式；具体装配按模式分流：全屏界面交给 tui-mode，非交互一次性执行
 * 走本文件的 print 路径。两条路径共用 config-selection 与 pipeline，审批、工具、插件与
 * 沙箱的规则因此只有一份。
 */
export async function main(argv: readonly string[]): Promise<number> {
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			writeStderr(`reins: ${error.message}\nHint: run reins --help for usage\n`);
			return 2;
		}
		throw error;
	}

	switch (options.command) {
		case "help":
			writeStdout(HELP_TEXT);
			return 0;
		case "version":
			writeStdout(`${readVersion()}\n`);
			return 0;
		case "print":
			initializeConfig(options);
			return runPrint(options);
		case "tui":
			return runTuiMode(options);
	}
}

async function runPrint(options: CliOptions): Promise<number> {
	const loaded = await loadSelection(options);
	if (!loaded.ok) {
		writeStderr(`${loaded.error.display}\n`);
		return 1;
	}
	const { config, selection } = loaded.value;

	const workRoot = process.cwd();
	const workspace = new WorkspaceBoundary(workRoot);
	const instructions = (): readonly PromptInstruction[] =>
		readInstructions(defaultInstructionSources(workRoot, loaded.trusted));

	// 审批链路：策略先立起来，插件装载时往里加规则
	const policy = new PermissionPolicy(config.approval);
	// 一次性提问没有人可问，因此不接 confirmer：需要询问的调用按拒绝处理
	const gate = new PermissionGate({
		policy,
		reviewer:
			config.approval === "auto" ? createReviewer(config, selection, workRoot) : undefined,
	});
	const terminals = new TerminalManager({ shellPath: config.shellPath });
	const pipeline = await assemblePipeline({
		config,
		workRoot,
		policy,
		gate,
		terminals,
	});
	if (pipeline === null) return 1;
	const { registry, sandbox, sandboxWarnings } = pipeline;
	const host = pipeline.host;
	for (const warning of sandboxWarnings) writeStderr(`${warning}\n`);

	const session = createSessionFor(workRoot, host.sessionStore());
	const compactor = createCompactor(config, selection);

	try {
		return await runPrintMode({
			prompt: options.prompt,
			createDriver: (onEvent) =>
				createDriverFor(
					{ config, selection, compactor },
					{ registry, session, workspace, sandbox, instructions },
					onEvent,
				),
			workspaceRoot: workRoot,
			json: options.json,
			stdout: writeStdout,
			stderr: writeStderr,
		});
	} finally {
		terminals.shutdown();
		await session.close();
	}
}
