import { AtSign, ChevronRight, Download, FolderOpen, Package, Paperclip, Plus, Puzzle, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../../api.ts";
import { cn, Tooltip, toast } from "../../components/ui/index.ts";
import { desktopBridge } from "../../platform.ts";
import type { McpServerInfo, SkillInfo } from "../../protocol.ts";
import { fileMentionPath, serverStatusLabel } from "./model.ts";

/** 技能字母头像的类目色:按序循环取用,与用量图表同一套色板。 */
const LETTER_COLORS = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)"] as const;

/** 加号浮层：根级四项，鼠标移入行时二级菜单在右侧级联浮出；二级面板自带搜索。 */
export function AddMenu({
	skills,
	mcpServers,
	workspacePath,
	onInsert,
	onSettings,
	onAddSkill,
}: {
	readonly skills: readonly SkillInfo[];
	readonly mcpServers: readonly McpServerInfo[];
	readonly workspacePath: string;
	onInsert(token: string): void;
	onSettings(): void;
	onAddSkill(): void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	/**
	 * 当前展开的二级面板。
	 *
	 * 光靠 CSS 的 :hover 与 :focus-within 会让两行同时成立：点过某行按钮后焦点留在那里，
	 * 再去悬停另一行，两个面板就会一起弹出来叠成一列。改成只认一个当前行。
	 */
	const [submenu, setSubmenu] = useState<string | undefined>(undefined);
	/** 右侧放不下面板时改向左开，窄窗口里不会被挤到窗口外。 */
	const [flipped, setFlipped] = useState<string | undefined>(undefined);
	const [fileQuery, setFileQuery] = useState("");
	const [fileHits, setFileHits] = useState<readonly string[]>([]);
	const [skillQuery, setSkillQuery] = useState("");
	const bridge = desktopBridge();
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
	};
	document.addEventListener("mousedown", onDown);
	// Esc 先关菜单:浮层开着时 Esc 的语义是「收起浮层」,不能落到输入卡变成打断回合
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		}
	};
	// 捕获阶段监听:输入卡的 Esc(打断回合)绑在冒泡路径上,菜单必须先于它拿到按键
	document.addEventListener("keydown", onKey, true);
	return () => {
		document.removeEventListener("mousedown", onDown);
		document.removeEventListener("keydown", onKey, true);
	};
}, [open]);

	// 文件搜索行:输入停稳后拉一次候选,与输入卡 @ 补全共用同一接口
	useEffect(() => {
		if (!open) return;
		const query = fileQuery.trim();
		if (query.length === 0) {
			setFileHits([]);
			return;
		}
		const timer = window.setTimeout(() => {
			void api
				.fileSearch(query, 6)
				.then((hits) => setFileHits(hits.map((hit) => hit.path)))
				.catch(() => {});
		}, 150);
		return () => window.clearTimeout(timer);
	}, [open, fileQuery]);

	const close = (): void => {
		setOpen(false);
		setSubmenu(undefined);
	};

	/** 指针离开这一行就收起它的面板；已经换成别的行时不动，避免快速扫过时互相清掉。 */
	const leave = (key: string): void => setSubmenu((current) => (current === key ? undefined : current));

	/** 进到一行就展开它的面板，并按剩余宽度决定开向哪边。 */
	const enter = (key: string, row: HTMLElement): void => {
		setSubmenu(key);
		const room = window.innerWidth - row.getBoundingClientRect().right;
		// 阈值跟面板的实际宽度上限一致（样式里的 min(320px, 46vw)），再加 8 的间距
		const needed = Math.min(320, window.innerWidth * 0.46) + 8;
		setFlipped(room < needed ? key : undefined);
	};

	const matchedSkills = skills.filter((skill) => skill.name.toLowerCase().includes(skillQuery.trim().toLowerCase()));

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
				<Plus className="ic ic-14" />
			</button>
			{open ? (
				<div
					className="pop add-menu animate-pop"
					role="menu"
					style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 45 }}
				>
					{/* 桌面壳直接唤起系统文件选择器；浏览器里没有系统对话框，退回输入 @ 走应用内补全 */}
					<div className="add-row">
						<button
							type="button"
							className="pop-i"
							onClick={() => {
								close();
								if (bridge === undefined) {
									onInsert("@");
									return;
								}
								void bridge
									.pickFile(workspacePath)
									.then((picked) => {
										if (picked === undefined) return;
										onInsert(`@${fileMentionPath(picked, workspacePath)} `);
									})
									.catch((cause: unknown) => toast(cause instanceof Error ? cause.message : String(cause), "error"));
							}}
						>
							<Paperclip className="ic ic-14" />
							<span>添加文件</span>
						</button>
					</div>

					<div className="add-row" onMouseEnter={(event) => enter("workspace", event.currentTarget)} onMouseLeave={() => leave("workspace")}>
						<button type="button" className="pop-i sub-trig" onFocus={() => setSubmenu("workspace")}>
							<AtSign className="ic ic-14" />
							<span>引用工作区文件</span>
							<ChevronRight className="ic ic-12 ck" />
						</button>
						<div className={cn("sub-fly", submenu === "workspace" && "is-on", flipped === "workspace" && "is-left")}>
							<div className="sub-panel">
								<div className="sub-search">
									<AtSign className="ic ic-12" />
									<input
										value={fileQuery}
										onChange={(event) => setFileQuery(event.target.value)}
										placeholder="搜索文件…"
										aria-label="搜索文件"
									/>
								</div>
								{fileHits.length === 0 ? (
									<button
										type="button"
										className="pop-i"
										onClick={() => {
											onInsert(`${workspacePath} `);
											close();
										}}
									>
										<FolderOpen className="ic ic-14" />
										引用整个工作区
									</button>
								) : (
									fileHits.map((path) => (
										<button
											key={path}
											type="button"
											className="pop-i"
											onClick={() => {
												onInsert(`@${path} `);
												close();
											}}
										>
											<Tooltip label={path} side="top" className="tip-grow">
												<span className="path">{path}</span>
											</Tooltip>
										</button>
									))
								)}
							</div>
						</div>
					</div>

					<div className="add-row" onMouseEnter={(event) => enter("skills", event.currentTarget)} onMouseLeave={() => leave("skills")}>
						<button type="button" className="pop-i sub-trig" onFocus={() => setSubmenu("skills")}>
							<Puzzle className="ic ic-14" />
							<span>技能</span>
							<ChevronRight className="ic ic-12 ck" />
						</button>
						<div className={cn("sub-fly", submenu === "skills" && "is-on", flipped === "skills" && "is-left")}>
							<div className="sub-panel">
								<div className="sub-search">
									<Puzzle className="ic ic-12" />
									<input
										value={skillQuery}
										onChange={(event) => setSkillQuery(event.target.value)}
										placeholder="搜索技能…"
										aria-label="搜索技能"
									/>
								</div>
								{matchedSkills.length === 0 ? (
									<div className="pop-i two" style={{ pointerEvents: "none" }}>
										<span className="sk-col">
											<span className="n">还没有技能</span>
											<span className="d">从设置里上传或放入技能目录</span>
										</span>
									</div>
								) : (
									matchedSkills.slice(0, 6).map((skill, index) => (
										<button
											key={skill.path}
											type="button"
											className="pop-i two"
											onClick={() => {
												onInsert(`$${skill.name} `);
												close();
											}}
										>
											<span
												className="letter"
												style={{ background: LETTER_COLORS[index % LETTER_COLORS.length] }}
											>
												{skill.name.slice(0, 1).toUpperCase()}
											</span>
											<span className="sk-col">
												<Tooltip label={skill.name} side="top" className="tip-col">
													<span className="n">{skill.name}</span>
												</Tooltip>
												<span className="d">{skill.description}</span>
											</span>
										</button>
									))
								)}
								<button
									type="button"
									className="pop-i pv-manage"
									onClick={() => {
										onAddSkill();
										close();
									}}
								>
									<Download className="ic ic-14" />
									从本地添加技能
								</button>
								<button
									type="button"
									className="pop-i pv-manage"
									onClick={() => {
										onSettings();
										close();
									}}
								>
									<Settings2 className="ic ic-14" />
									管理技能
								</button>
							</div>
						</div>
					</div>

					<div className="add-row" onMouseEnter={(event) => enter("mcp", event.currentTarget)} onMouseLeave={() => leave("mcp")}>
						<button type="button" className="pop-i sub-trig" onFocus={() => setSubmenu("mcp")}>
							<Package className="ic ic-14" />
							<span>连接器</span>
							<span className="badge">MCP</span>
							<ChevronRight className="ic ic-12 ck" />
						</button>
						<div className={cn("sub-fly", submenu === "mcp" && "is-on", flipped === "mcp" && "is-left")}>
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
												<Tooltip label={server.name} side="top" className="tip-col">
													<span className="n">{server.name}</span>
												</Tooltip>
												<span className="d">{serverStatusLabel(server.status)}</span>
											</span>
										</div>
									))
								)}
								<button
									type="button"
									className="pop-i pv-manage"
									onClick={() => {
										onSettings();
										close();
									}}
								>
									<Settings2 className="ic ic-14" />
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
