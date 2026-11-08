import { Blocks } from "lucide-react";
import type { ReactElement } from "react";

import { pluginKindLabel } from "../lib/format.ts";
import type { PluginInfo } from "../protocol.ts";

/** 已装载的插件清单；本轮只展示，不提供装卸。 */
export function PluginsPane({ plugins }: { readonly plugins: readonly PluginInfo[] }): ReactElement {
	return (
		<>
			<div className="panel-sec">
				插件<span className="n">{plugins.length}</span>
			</div>
			<div className="tree">
				{plugins.length === 0 ? (
					<div className="tree-row" style={{ color: "var(--ink-4)" }}>
						没有装载插件
					</div>
				) : (
					plugins.map((plugin) => (
						<div
							key={plugin.name}
							className="flex items-center gap-2"
							style={{ height: 30, padding: "0 6px", borderBottom: "1px solid var(--rule)" }}
						>
							<Blocks className="ic-12" style={{ color: "var(--ink-3)" }} />
							<span className="min-w-0 flex-1 truncate text-[var(--fs-12)]" style={{ color: "var(--ink-2)" }}>
								{plugin.name}
							</span>
							<span className="badge">{pluginKindLabel(plugin.kind)}</span>
							{plugin.disabled ? <span className="badge dash">已禁用</span> : null}
						</div>
					))
				)}
			</div>
		</>
	);
}
