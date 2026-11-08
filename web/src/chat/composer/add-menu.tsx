import { AtSign, Blocks, ChevronRight, FolderOpen, Plus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { desktopBridge } from "../../platform.ts";
import type { McpServerInfo, SkillInfo } from "../../protocol.ts";
import { serverStatusLabel } from "./model.ts";

/** 加号浮层：根级四项，鼠标移入行时二级菜单在右侧级联浮出。 */
export function AddMenu({
	skills,
	mcpServers,
	workspacePath,
	onInsert,
	onSettings,
}: {
	readonly skills: readonly SkillInfo[];
	readonly mcpServers: readonly McpServerInfo[];
	readonly workspacePath: string;
	onInsert(token: string): void;
	onSettings(): void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const bridge = desktopBridge();
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const close = (): void => setOpen(false);

	return (
		<div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
			<button
				type="button"
				className="add"
				title="添加文件或调用指令"
				aria-label="添加文件或调用指令"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<Plus className="ic-14" />
			</button>
			{open ? (
				<div
					className="pop add-menu animate-pop"
					role="menu"
					style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 45 }}
				>
					<div className="add-row">
						<button type="button" className="pop-i">
							<AtSign className="ic-14" />
							<span>添加文件</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onInsert("@");
										close();
									}}
								>
									引用文件
								</button>
								{bridge === undefined ? null : (
									<button
										type="button"
										className="pop-i"
										onClick={() => {
											bridge.openWorkspaceFolder(workspacePath);
											close();
										}}
									>
										在资源管理器中打开
									</button>
								)}
							</div>
						</div>
					</div>

					<div className="add-row">
						<button type="button" className="pop-i">
							<FolderOpen className="ic-14" />
							<span>引用工作区文件</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onInsert("@");
										close();
									}}
								>
									搜索文件…
								</button>
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onInsert(`${workspacePath} `);
										close();
									}}
								>
									引用整个工作区
								</button>
							</div>
						</div>
					</div>

					<div className="add-row">
						<button type="button" className="pop-i">
							<Sparkles className="ic-14" />
							<span>技能</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								{skills.length === 0 ? (
									<div className="pop-i two" style={{ pointerEvents: "none" }}>
										<span className="sk-col">
											<span className="n">还没有技能</span>
											<span className="d">从设置里上传或放入技能目录</span>
										</span>
									</div>
								) : (
									skills.slice(0, 6).map((skill) => (
										<button
											key={skill.path}
											type="button"
											className="pop-i two"
											onClick={() => {
												onInsert(`$${skill.name} `);
												close();
											}}
										>
											<span className="sk-col">
												<span className="n">{skill.name}</span>
												<span className="d">{skill.description}</span>
											</span>
										</button>
									))
								)}
								<div className="pop-sep" />
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onSettings();
										close();
									}}
								>
									管理技能
								</button>
							</div>
						</div>
					</div>

					<div className="add-row">
						<button type="button" className="pop-i">
							<Blocks className="ic-14" />
							<span>连接器</span>
							<ChevronRight className="ic-12 ck" />
						</button>
						<div className="sub-fly">
							<div className="sub-panel">
								{mcpServers.length === 0 ? (
									<div className="pop-i two" style={{ pointerEvents: "none" }}>
										<span className="sk-col">
											<span className="n">还没有连接器</span>
											<span className="d">MCP 服务器接入后在下一回合可用</span>
										</span>
									</div>
								) : (
									mcpServers.slice(0, 6).map((server) => (
										<div key={server.name} className="pop-i two" style={{ pointerEvents: "none" }}>
											<span className="sk-col">
												<span className="n">{server.name}</span>
												<span className="d">{serverStatusLabel(server.status)}</span>
											</span>
										</div>
									))
								)}
								<div className="pop-sep" />
								<button
									type="button"
									className="pop-i"
									onClick={() => {
										onSettings();
										close();
									}}
								>
									管理连接器
								</button>
							</div>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
