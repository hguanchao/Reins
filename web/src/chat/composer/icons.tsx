import { type ReactElement } from "react";

export function PencilIcon(): ReactElement {
	return (
		<svg className="ic ic-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		</svg>
	);
}

export function GitBranchIcon(): ReactElement {
	return (
		<svg className="ic ic-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M15 6a9 9 0 0 0-9 9V3" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
		</svg>
	);
}
