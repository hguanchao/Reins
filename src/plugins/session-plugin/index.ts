import type { Plugin, PluginApi } from "../host.ts";
import { JsonlSessionStore } from "./jsonl-store.ts";

/**
 * 随包分发的会话存储插件。
 *
 * 会话的语义属于宿主，落到磁盘这件事接入的是文件系统，因此按插件的标准分发：关掉它之后
 * 会话仍能在内存里完整地跑完一次对话，只是不留文件。
 */
export const name = "session-plugin";

export function setup(api: PluginApi): void {
	api.registerSessionStore(new JsonlSessionStore());
}

export default { name, setup } satisfies Plugin;
