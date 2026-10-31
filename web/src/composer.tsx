import { ArrowUp, ChevronDown, Folder, Square, TriangleAlert } from "lucide-react";
import { useState, type KeyboardEvent, type ReactElement } from "react";

import type { ApprovalMode, ModelInfo } from "./types.ts";

const MODE_LABELS: Record<ApprovalMode, string> = {
	ask: "每次询问",
	auto: "自动审批",
	yolo: "完全访问",
};

/** 可开合的选择器 chip;面板出现时有一层透明遮罩负责点外关闭。 */
function Selector({
	display,
	panelClass,
	children,
}: {
	display: ReactElement;
	panelClass: string;
	children: (close: () => void) => ReactElement;
}): ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<div className="sel">
			<button type="button" className="chip" onClick={() => setOpen(!open)}>
				{display}
				<ChevronDown size={12} className="caret" />
			</button>
			{open ? (
				<>
					<div
						className="backdrop"
						onClick={() => {
							setOpen(false);
						}}
					/>
					<div className={"panel " + panelClass}>{children(() => setOpen(false))}</div>
				</>
			) : null}
		</div>
	);
}

function WorkspaceChip({ workspace }: { workspace: string }): ReactElement {
	return (
		<span className="chip static" title={workspace}>
			<Folder size={13} className="chip-icon" />
			{workspace}
		</span>
	);
}

function ApprovalSelector({
	mode,
	onChange,
}: {
	mode: ApprovalMode;
	onChange: (mode: ApprovalMode) => void;
}): ReactElement {
	const danger = mode === "yolo";
	return (
		<Selector
			panelClass="mode-panel"
			display={
				<span className={danger ? "warn-text" : undefined}>
					{danger ? <TriangleAlert size={13} /> : null}
					{MODE_LABELS[mode]}
				</span>
			}
		>
			{(close) => (
				<>
					{(Object.keys(MODE_LABELS) as ApprovalMode[]).map((item) => (
						<button
							type="button"
							key={item}
							className={"opt" + (item === "yolo" ? " danger" : "")}
							onClick={() => {
								onChange(item);
								close();
							}}
						>
							{item === "yolo" ? <TriangleAlert size={13} /> : null}
							{MODE_LABELS[item]}
						</button>
					))}
				</>
			)}
		</Selector>
	);
}

function ModelSelector({
	models,
	current,
	onChange,
}: {
	models: readonly ModelInfo[];
	current: ModelInfo;
	onChange: (model: ModelInfo) => void;
}): ReactElement {
	return (
		<Selector panelClass="model-panel" display={<span>{current.name}</span>}>
			{(close) => (
				<>
					{models.map((item) => (
						<button
							type="button"
							key={item.provider + "/" + item.model}
							className={
								"opt" + (item.model === current.model && item.provider === current.provider ? " picked" : "")
							}
							onClick={() => {
								onChange(item);
								close();
							}}
						>
							{item.name}
						</button>
					))}
				</>
			)}
		</Selector>
	);
}

/**
 * 输入区:圆角卡壳,上排工作区与选择器,中间文本框,下排左审批右发送。
 * Enter 发送、Shift+Enter 换行、Esc 中断。
 */
export function Composer({
	running,
	workspace,
	approvalMode,
	onApprovalMode,
	models,
	model,
	onModel,
	onSend,
	onStop,
}: {
	running: boolean;
	workspace: string;
	approvalMode: ApprovalMode;
	onApprovalMode: (mode: ApprovalMode) => void;
	models: readonly ModelInfo[];
	model: ModelInfo;
	onModel: (model: ModelInfo) => void;
	onSend: (text: string) => void;
	onStop: () => void;
}): ReactElement {
	const [text, setText] = useState("");

	const submit = (): void => {
		if (running || text.trim().length === 0) return;
		onSend(text);
		setText("");
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Escape" && running) {
			event.preventDefault();
			onStop();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="composer">
			<div className="shell">
				<div className="sel-row">
					<WorkspaceChip workspace={workspace} />
				</div>
				<textarea
					value={text}
					placeholder={running ? "回合进行中,Esc 可中断…" : "输入消息,Enter 发送,Shift+Enter 换行"}
					rows={2}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
				/>
				<div className="row">
					<ApprovalSelector mode={approvalMode} onChange={onApprovalMode} />
					<span className="spacer" />
					<ModelSelector models={models} current={model} onChange={onModel} />
					{running ? (
						<button type="button" className="stop" title="中断当前回合 (Esc)" onClick={onStop}>
							<Square size={10} fill="currentColor" />
						</button>
					) : (
						<button
							type="button"
							className="send"
							title="发送 (Enter)"
							disabled={text.trim().length === 0}
							onClick={submit}
						>
							<ArrowUp size={16} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
