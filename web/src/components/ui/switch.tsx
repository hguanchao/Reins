import type { ReactElement } from "react";

import { cn } from "./cn.ts";

/**
 * 开关。
 *
 * 32×18，关闭时描边空心 + 次级墨点，开启时实心墨 + 反白圆点位移 14px。命中区由
 * ::after 向外扩到 44px 见方，视觉尺寸不跟着变大。
 */
export function Switch({
	checked,
	onCheckedChange,
	label,
	disabled,
}: {
	readonly checked: boolean;
	onCheckedChange(checked: boolean): void;
	readonly label: string;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={cn("sw", disabled && "pointer-events-none opacity-40")}
		>
			<i />
		</button>
	);
}

/** 复选框：勾选即实心墨 + 反白对勾。 */
export function Checkbox({
	checked,
	onCheckedChange,
	label,
	disabled,
}: {
	readonly checked: boolean;
	onCheckedChange(checked: boolean): void;
	readonly label: string;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			role="checkbox"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={cn("cb", disabled && "pointer-events-none opacity-40")}
		>
			<svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
				<path d="M1.5 5.2 3.8 7.5 8.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			</svg>
		</button>
	);
}

/** 单选：同心圆，选中时外环 2px 墨。 */
export function Radio({
	checked,
	onSelect,
	label,
	disabled,
}: {
	readonly checked: boolean;
	onSelect(): void;
	readonly label: string;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={onSelect}
			className={cn("rd", disabled && "pointer-events-none opacity-40")}
		/>
	);
}

/** 分段控制：底槽 + 选中白片 + 1px 微影。 */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	label,
}: {
	readonly options: readonly { readonly key: T; readonly label: string }[];
	readonly value: T;
	onChange(next: T): void;
	readonly label: string;
}): ReactElement {
	return (
		<div className="seg" role="group" aria-label={label}>
			{options.map((option) => (
				<button
					key={option.key}
					type="button"
					aria-pressed={option.key === value}
					onClick={() => onChange(option.key)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
