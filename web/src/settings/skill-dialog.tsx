import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";

const FIELD =
	"h-9 w-full rounded-md border-[0.5px] border-input-border bg-input px-3 text-[13px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";
const AREA =
	"w-full resize-y rounded-md border-[0.5px] border-input-border bg-input px-3 py-2 text-[13px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";

/** 新建技能：名称、描述与 SKILL.md 正文。 */
export function SkillDialog({
	open,
	onClose,
	onCreated,
}: {
	readonly open: boolean;
	onClose(): void;
	onCreated(): void;
}): ReactElement {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!open) return;
		setName("");
		setDescription("");
		setContent("");
		setSaving(false);
		setError(undefined);
	}, [open]);

	const submit = (): void => {
		if (saving) return;
		const trimmedName = name.trim();
		const trimmedDescription = description.trim();
		const trimmedContent = content.trim();
		if (trimmedName.length === 0 || trimmedDescription.length === 0 || trimmedContent.length === 0) {
			setError("名称、描述和指令正文都不能为空");
			return;
		}
		setSaving(true);
		setError(undefined);
		void api
			.createSkill({
				name: trimmedName,
				description: trimmedDescription,
				content: trimmedContent,
			})
			.then(() => {
				toast("技能已创建");
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
			title="新建技能"
			footer={
				<>
					<Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" disabled={saving} onClick={submit}>
						{saving ? "创建中…" : "创建"}
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
						autoFocus
						className={FIELD}
					/>
					<span className="text-[11px] leading-4 text-foreground-subtlest">
						仅支持小写字母、数字、- 和 _，会作为技能目录名。
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
						className={FIELD}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">指令正文</span>
					<textarea
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder={"# 步骤\n\n1. 读取输入\n2. 产出结果"}
						aria-label="技能指令正文"
						className={`${AREA} min-h-[180px] font-mono text-[12px] leading-5`}
					/>
				</label>
				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}
