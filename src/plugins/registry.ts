import toolsPlugin from "./tools-plugin/index.ts";
import type { Plugin } from "./host.ts";

/**
 * 组合根。
 *
 * 全项目只有这个文件导入具体的插件：宿主模块只认识插件契约，装配处从这里取清单再驱动生命
 * 周期。这样「宿主不依赖具体插件」这条规则才有落点——依赖方向始终是 plugins 指向宿主，
 * 反过来一次都没有。
 */
export function bundledPlugins(): readonly Plugin[] {
	return [toolsPlugin];
}

export { toolsPlugin };
