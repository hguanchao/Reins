import { Blocks } from "lucide-react";
import type { ReactElement } from "react";

import { pluginKindLabel } from "../lib/format.ts";
import type { PluginInfo } from "../protocol.ts";

/** 已装载的插件清单；本轮只展示，不提供装卸。 */
export function PluginsPane({ plugins }: { readonly plugins: readonly PluginInfo[] }): ReactElement {
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3 text-ui-sm text-foreground-subtle">
				<Blocks className="size-4" />
				<span className="flex-1">插件</span>
				<span className="font-mono text-ui-xs text-foreground-subtlest">{plugins.length}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{plugins.length === 0 ? (
					<div className="px-2 py-2 text-ui-sm text-foreground-subtlest">没有装载插件。</div>
				) : (
					<div className="flex flex-col gap-1">
						{plugins.map((plugin) => (
							<div
								key={plugin.name}
								className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-hover"
							>
								<span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{plugin.name}</span>
								<span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-ui-xs text-foreground-subtle">
									{pluginKindLabel(plugin.kind)}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
