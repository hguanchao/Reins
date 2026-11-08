import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { api } from "../api.ts";
import { Dialog, toast } from "../components/ui/index.ts";

/** 编辑技能：名称只读，描述与正文写回 SKILL.md。 */
export function SkillDialog({
	open,
	skill,
	onClose,
	onSaved,
}: {
	readonly open: boolean;
	readonly skill: { readonly path: string; readonly name: string };
	onClose(): void;
	onSaved(): void;
}): ReactElement {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!open) return;
		setName(skill.name);
		setDescription("");
		setContent("");
		setSaving(false);
		setError(undefined);
		setLoadError(undefined);
		setLoading(true);
		let cancelled = false;
		void api
			.skillContent(skill.path)
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
	}, [open, skill.path, skill.name]);

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
		void api
			.updateSkill({
				path: skill.path,
				name: trimmedName,
				description: trimmedDescription,
				content: trimmedContent,
			})
			.then(() => {
				toast("技能已保存");
				onSaved();
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
			title="编辑技能"
			footer={
				<>
					<button type="button" className="b b-line" disabled={saving} onClick={onClose}>
						取消
					</button>
					<button
						type="button"
						className="b b-solid"
						disabled={saving || loading || loadError !== undefined}
						onClick={submit}
					>
						{saving ? "保存中…" : "保存"}
					</button>
				</>
			}
		>
			<label>
				<span className="form-label">名称</span>
				<input value={name} aria-label="技能名称" disabled className="form-input" />
				<span className="form-hint">编辑时名称不可修改。</span>
			</label>
			<label>
				<span className="form-label">描述</span>
				<input
					value={description}
					onChange={(event) => setDescription(event.target.value)}
					onKeyDown={submitOnEnter}
					placeholder="一句话说明这个技能做什么"
					aria-label="技能描述"
					disabled={loading}
					className="form-input"
				/>
			</label>
			<label>
				<span className="form-label">指令正文</span>
				<textarea
					value={content}
					onChange={(event) => setContent(event.target.value)}
					placeholder={loading ? "正在读取…" : "# 步骤\n\n1. 读取输入\n2. 产出结果"}
					aria-label="技能指令正文"
					disabled={loading}
					className="form-area"
					style={{ minHeight: 200 }}
				/>
			</label>
			{loadError === undefined ? null : <p className="form-error">{loadError}</p>}
			{error === undefined ? null : <p className="form-error">{error}</p>}
		</Dialog>
	);
}
