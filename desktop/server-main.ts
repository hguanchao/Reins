import { runServeMode } from "#src/cli/serve-mode.ts";
import type { CliOptions } from "#src/cli/args.ts";
import { registeredWorkspace } from "#src/workspace/catalog.ts";

/**
 * 桌面版的服务端入口:esbuild 把它连同整个内核打成单 JS(server.mjs)。
 *
 * 与 CLI 的差别只有启动参数:端口让系统挑(就绪行会带回来),信任直接成立——工作区目录
 * 是使用者刚刚在原生对话框里亲手选的,这就是明确的意图。装配路径与其余模式共用一份。
 */
const options: CliOptions = {
	command: "serve",
	prompt: "",
	configPath: undefined,
	providersPath: undefined,
	trust: true,
	resume: undefined,
	json: false,
	port: 0,
	pluginAction: undefined,
	pluginSource: undefined,
};

const resumeSessionId = process.env["REINS_DESKTOP_RESUME_SESSION"] || undefined;
const requestedWorkspace = process.env["REINS_DESKTOP_NEW_SESSION_WORKSPACE"] || undefined;
if (resumeSessionId !== undefined && requestedWorkspace !== undefined) {
	throw new Error("Desktop startup cannot resume and create a session at the same time");
}
const newWorkspacePath =
	requestedWorkspace === undefined ? undefined : registeredWorkspace(requestedWorkspace);
if (requestedWorkspace !== undefined && newWorkspacePath === undefined) {
	throw new Error("Desktop startup workspace is not registered");
}

process.exitCode = await runServeMode(options, {
	desktopManaged: true,
	...(resumeSessionId === undefined ? {} : { resumeSessionId }),
	...(newWorkspacePath === undefined ? {} : { newWorkspacePath }),
});
