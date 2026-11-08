import { Sparkles } from "lucide-react";
import type { ReactElement } from "react";

import type { SkillInfo } from "../protocol.ts";

/** 技能列表：名称、说明与作用域；输入框里用 `$名称` 引用。 */
export function SkillsPane({ skills }: { readonly skills: readonly SkillInfo[] }): ReactElement {
	return (
		<>
			<div className="panel-sec">
				技能<span className="n">{skills.length}</span>
			</div>
			<div className="tree">
				{skills.length === 0 ? (
					<div className="tree-row" style={{ color: "var(--ink-4)" }}>
						没有发现技能
					</div>
				) : (
					skills.map((skill) => (
						<div key={skill.path} style={{ padding: "6px 6px 8px", borderBottom: "1px solid var(--rule)" }}>
							<div className="flex items-center gap-2">
								<Sparkles className="ic ic-12" style={{ color: "var(--ink-3)" }} />
								<span
									className="text-[var(--fs-12)]"
									style={{ color: "var(--ink)", fontFamily: "var(--mono)" }}
								>
									${skill.name}
								</span>
								<span className="badge" style={{ marginLeft: "auto" }}>
									{skill.scope === "user" ? "用户级" : "项目级"}
								</span>
							</div>
							<div className="mt-1 text-[var(--fs-11)]" style={{ color: "var(--ink-3)", lineHeight: 1.6 }}>
								{skill.description}
							</div>
						</div>
					))
				)}
			</div>
		</>
	);
}
