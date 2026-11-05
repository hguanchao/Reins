import { Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";
import { formatKb } from "./settings-model.ts";

const MAX_UPLOAD_BYTES = 64 * 1024;

/** 上传技能：读取一个 SKILL.md，frontmatter 里的 name 决定落盘目录。 */
export function SkillUploadDialog({
	open,
	onClose,
	onCreated,
}: {
	readonly open: boolean;
	onClose(): void;
	onCreated(): void;
}): ReactElement {
	const [fileName, setFileName] = useState<string | undefined>(undefined);
	const [size, setSize] = useState(0);
	const [content, setContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const input = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setFileName(undefined);
		setSize(0);
		setContent("");
		setSaving(false);
		setError(undefined);
		if (input.current !== null) input.current.value = "";
	}, [open]);

	const pick = (file: File | undefined): void => {
		if (file === undefined) return;
		if (!file.name.toLowerCase().endsWith(".md")) {
			setError("请选择 .md 文件");
			return;
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			setError(`文件超过 ${MAX_UPLOAD_BYTES / 1024} KB`);
			return;
		}
		setError(undefined);
		setFileName(file.name);
		setSize(file.size);
		void file
			.text()
			.then(setContent)
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	};

	const submit = (): void => {
		if (saving) return;
		if (content.trim().length === 0) {
			setError("请先选择一个 SKILL.md 文件");
			return;
		}
		setSaving(true);
		setError(undefined);
		void api
			.uploadSkill(content)
			.then(() => {
				toast("技能已上传");
				onCreated();
				onClose();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title="上传技能"
			footer={
				<>
					<Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" disabled={saving} onClick={submit}>
						{saving ? "上传中…" : "上传"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-[0.5px] border-dashed border-border bg-surface px-4 py-7 text-center transition-colors hover:bg-surface-hover">
					<Upload className="size-5 text-foreground-subtlest" />
					<span className="text-[13px] leading-5">{fileName ?? "选择一个 SKILL.md 文件"}</span>
					<span className="text-[11px] leading-4 text-foreground-subtlest">
						{fileName === undefined
							? "文件需包含 name 与 description frontmatter"
							: `${formatKb(size)} · 点击重新选择`}
					</span>
					<input
						ref={input}
						type="file"
						accept=".md,text/markdown"
						aria-label="选择 SKILL.md 文件"
						className="sr-only"
						onChange={(event) => pick(event.target.files?.[0])}
					/>
				</label>
				<p className="m-0 text-[11px] leading-4 text-foreground-subtlest">
					上传后会保存到用户级技能目录；同名技能会被拒绝，不会覆盖现有内容。
				</p>
				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}
