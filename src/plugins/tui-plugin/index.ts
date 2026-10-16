import { ProcessTerminal, type Terminal } from "../../tui/index.ts";
import type { Plugin, PluginApi } from "../host.ts";
import { TerminalFrontend } from "./frontend.ts";

/**
 * 随包分发的界面插件。
 *
 * 交互界面是可替换的一层：宿主只定义「有东西能接管终端跑起来」这个接缝，怎么显示、有哪些
 * 命令都由这里决定。关掉它之后，非交互模式依然完整可用，因此它按插件的标准分发。
 */
export const name = "tui-plugin";

export function setup(api: PluginApi): void {
	api.registerFrontend(
		new TerminalFrontend({ terminal: createTerminal(), env: process.env }),
	);
}

/** 真实终端。测试直接构造 TerminalFrontend 并换上内存终端，不必经过这里。 */
function createTerminal(): Terminal {
	return new ProcessTerminal(process.stdin, process.stdout);
}

export default { name, setup } satisfies Plugin;
