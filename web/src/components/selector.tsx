import { useState, type ReactElement } from "react";

/** 可开合的选择器:chip 触发面板,backdrop 负责点外关闭;placement 决定面板在上下哪一侧。 */
export function Selector({
	display,
	panelClass,
	placement = "below",
	children,
}: {
	display: ReactElement;
	panelClass: string;
	placement?: "above" | "below";
	children: (close: () => void) => ReactElement;
}): ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<div className="sel">
			<button type="button" className="chip" onClick={() => setOpen(!open)}>
				{display}
			</button>
			{open ? (
				<>
					<div
						className="backdrop"
						onClick={() => {
							setOpen(false);
						}}
					/>
					<div className={`panel ${panelClass} ${placement === "above" ? "above" : "below"}`}>
						{children(() => setOpen(false))}
					</div>
				</>
			) : null}
		</div>
	);
}
