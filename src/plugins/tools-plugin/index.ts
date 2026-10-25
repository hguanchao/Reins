import type { Plugin, PluginApi } from "../host.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";

/**
 * 随包分发的工具插件。
 *
 * 这里的三个工具都是「能改代码」之外的手段：列目录、找路径、搜内容。它们都可以用 bash 近似
 * 出来，去掉之后产品依然完整，所以按插件的标准分发；也正因为如此，想换成更快的实现（比如
 * 接上专门的检索工具）时替换掉这个插件就够了，不必动宿主。
 */
const name = "tools-plugin";

function setup(api: PluginApi): void {
	api.registerTool(lsTool);
	api.registerTool(findTool);
	api.registerTool(grepTool);
}

export default { name, setup } satisfies Plugin;
