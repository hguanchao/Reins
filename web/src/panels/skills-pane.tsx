import { Sparkles } from "lucide-react";
import type { ReactElement } from "react";

import type { SkillInfo } from "../protocol.ts";

/** 技能列表：名称、说明与文件位置；输入框里用 $名称 引用。 */
export function SkillsPane({ skills }: { readonly skills: readonly SkillInfo[] }): ReactElement {
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3 text-ui-sm text-foreground-subtle">
				<Sparkles className="size-4" />
				<span className="flex-1">技能</span>
				<span className="font-mono text-ui-xs text-foreground-subtlest">{skills.length}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{skills.length === 0 ? (
					<div className="px-2 py-2 text-ui-sm text-foreground-subtlest">没有发现技能。</div>
				) : (
					<div className="flex flex-col gap-1">
						{skills.map((skill) => (
							<div key={skill.path} className="rounded-lg px-2 py-1.5 hover:bg-surface-hover">
								<div className="flex items-center gap-2">
									<span className="font-mono text-ui-sm text-foreground">${skill.name}</span>
								</div>
								<div className="mt-0.5 text-ui-sm text-foreground-subtle">{skill.description}</div>
								<div className="mt-0.5 break-all font-mono text-ui-xs text-foreground-subtlest">
									{skill.path}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
