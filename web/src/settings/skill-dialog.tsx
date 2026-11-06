import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";

const FIELD =
	"h-9 w-full rounded-md border-[0.5px] border-input-border bg-input px-3 text-[13px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";
const AREA =
	"w-full resize-y rounded-md border-[0.5px] border-input-border bg-input px-3 py-2 text-[13px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";

/** 新建或编辑技能：名称、描述与 SKILL.md 正文；编辑时名称只读。 */
export function SkillDialog({
	open,
	skill,
	onClose,
	onCreated,
}: {
	readonly open: boolean;
	/** 编辑目标；缺省时是新建 */
	readonly skill?: { readonly path: string; readonly name: string };
	onClose(): void;
	onCreated(): void;
}): ReactElement {
	// 用字符串做依赖：调用方每次渲染都可能新建对象，按对象比较会反复重新拉取正文
	const skillPath = skill?.path;
	const skillName = skill?.name;
	const editing = skillPath !== undefined;
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!open) return;
		setSaving(false);
		setError(undefined);
		setLoadError(undefined);
		if (skillPath === undefined) {
			setName("");
			setDescription("");
			setContent("");
			setLoading(false);
			return;
		}

		setName(skillName ?? "");
		setDescription("");
		setContent("");
		setLoading(true);
		let cancelled = false;
		void api
			.skillContent(skillPath)
			.then((document) => {
				if (cancelled) return;
				setName(document.name);
				setDescription(document.description);
				setContent(document.content);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setLoadError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, skillPath, skillName]);

	const submit = (): void => {
		if (saving || loading || loadError !== undefined) return;
		const trimmedName = name.trim();
		const trimmedDescription = description.trim();
		const trimmedContent = content.trim();
		if (trimmedName.length === 0 || trimmedDescription.length === 0 || trimmedContent.length === 0) {
			setError("名称、描述和指令正文都不能为空");
			return;
		}
		setSaving(true);
		setError(undefined);
		const request =
			editing && skillPath !== undefined
				? api.updateSkill({
						path: skillPath,
						name: trimmedName,
						description: trimmedDescription,
						content: trimmedContent,
					})
				: api.createSkill({
						name: trimmedName,
						description: trimmedDescription,
						content: trimmedContent,
					});
		void request
			.then(() => {
				toast(editing ? "技能已保存" : "技能已创建");
				onCreated();
				onClose();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		submit();
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title={editing ? "编辑技能" : "新建技能"}
			footer={
				<>
					<Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
						取消
					</Button>
					<Button
						variant="primary"
						size="sm"
						disabled={saving || loading || loadError !== undefined}
						onClick={submit}
					>
						{saving ? (editing ? "保存中…" : "创建中…") : editing ? "保存" : "创建"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">名称</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={submitOnEnter}
						placeholder="release-notes"
						aria-label="技能名称"
						disabled={editing || loading}
						autoFocus={!editing}
						className={FIELD}
					/>
					<span className="text-[11px] leading-4 text-foreground-subtlest">
						{editing
							? "编辑时名称不可修改。"
							: "仅支持小写字母、数字、- 和 _，会作为技能目录名。"}
					</span>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">描述</span>
					<input
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						onKeyDown={submitOnEnter}
						placeholder="一句话说明这个技能做什么"
						aria-label="技能描述"
						disabled={loading}
						className={FIELD}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">指令正文</span>
					<textarea
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder={loading ? "正在读取…" : "# 步骤\n\n1. 读取输入\n2. 产出结果"}
						aria-label="技能指令正文"
						disabled={loading}
						className={`${AREA} min-h-[180px] font-mono text-[12px] leading-5`}
					/>
				</label>
				{loadError === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{loadError}</p>
				)}
				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}
