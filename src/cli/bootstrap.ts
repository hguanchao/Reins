import {
	defaultInstructionSources,
	readInstructions,
	type PromptInstruction,
} from "#src/agent/instructions.ts";
import { PermissionGate, PermissionPolicy } from "#src/permission/policy.ts";
import type { McpControl } from "#src/mcp/service.ts";
import { WorkspaceBoundary } from "#src/workspace/boundary.ts";
import { readVersion } from "#src/version.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "#src/cli/args.ts";
import { loadSelection } from "#src/cli/config-selection.ts";
import { initializeConfig } from "#src/cli/initialize-config.ts";
import { writeStderr, writeStdout } from "#src/cli/output.ts";
import {
	assemblePipeline,
	createCompactor,
	createDriverFor,
	createReviewer,
} from "#src/cli/pipeline.ts";
import { runPrintMode } from "#src/cli/print-mode.ts";
import { createSessionFor } from "#src/cli/session/factory.ts";
import { runPluginCommand } from "#src/cli/plugin-command.ts";
import { runTuiMode } from "#src/cli/tui-mode.ts";

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
		case "plugin":
			// 插件管理不读配置也不建会话：它只操作插件目录本身
			return runPluginCommand(options);
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
	// MCP 的限时收口交给首条消息前：非交互同样不该拿半套工具清单发第一次请求
	let mcpControl: McpControl | undefined;
	const pipeline = await assemblePipeline({
		config,
		workRoot,
		policy,
		gate,
		extensionContext: { mode: "print", projectTrusted: "trusted" in loaded && loaded.trusted },
		onMcpControl: (control) => {
			mcpControl = control;
		},
	});
	if (pipeline === null) return 1;
	const { registry, sandbox, sandboxWarnings } = pipeline;
	const host = pipeline.host;
	for (const warning of sandboxWarnings) writeStderr(`${warning}\n`);
	// 声明式插件的装载结论与失败原因：非交互模式没有界面可看，只能写到 stderr
	for (const line of pipeline.pluginReport) writeStderr(`reins: ${line}\n`);

	const session = createSessionFor(workRoot, host.sessionStore());
	const compactor = createCompactor(config, selection);

	try {
		return await runPrintMode({
			prompt: options.prompt,
			createDriver: (onEvent) => {
				const driver = createDriverFor(
					{ config, selection, compactor },
					{ registry, session, workspace, sandbox, instructions },
					onEvent,
				);
				return {
					run: async (prompt, signal) => {
						await mcpControl?.awaitStartup();
						return driver.run(prompt, signal);
					},
				};
			},
			workspaceRoot: workRoot,
			json: options.json,
			stdout: writeStdout,
			stderr: writeStderr,
		});
	} finally {
		await session.close();
	}
}
