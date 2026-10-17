/**
 * 滚动视口。
 *
 * 主区显示的是会话里的一段窗口。会话只追加：新内容永远接在末尾，已经提交的行不会变。视口
 * 因此把「看哪儿」记成内容里的绝对行号，而不是「离末尾还有多少行」——后者会被末尾的增长推着
 * 走，使用者正翻阅历史时画面会自己往下滑。
 *
 * 视口只管滚动状态，不知道内容是什么：窗口的边界由内容行数与可用高度算出来。什么时候算
 * 「贴着末尾」也在这里定：内容不够一屏，或者翻回了底部，都算跟尾，新内容到达时画面跟着走。
 */

export interface ViewportWindow {
	/** 窗口顶端那一行在内容里的行号 */
	readonly start: number;
	/** 是否贴着内容末尾 */
	readonly following: boolean;
}

export class Viewport {
	#following = true;
	#top = 0;

	/** 算出当前窗口。除了跟尾，窗口顶端只会停在 [0, 末尾] 之间。 */
	window(total: number, height: number): ViewportWindow {
		const last = Math.max(0, total - height);
		const start = this.#following ? last : Math.min(this.#top, last);
		return { start, following: start >= last };
	}

	/** 按行滚动，正数向下。翻到底部就恢复跟尾。 */
	scrollBy(delta: number, total: number, height: number): void {
		this.#moveTo(this.window(total, height).start + delta, total, height);
	}

	/** 按页滚动，正数向下。一步半屏：一眼能接上上一页的内容。 */
	scrollPages(pages: number, total: number, height: number): void {
		this.scrollBy(pages * Math.max(1, Math.floor(height / 2)), total, height);
	}

	/** 跳到指定行；拖动滚动条时用。 */
	scrollTo(index: number, total: number, height: number): void {
		this.#moveTo(index, total, height);
	}

	/** 跳到内容开头。 */
	toTop(): void {
		this.#following = false;
		this.#top = 0;
	}

	/** 回到末尾并恢复跟尾。 */
	toEnd(): void {
		this.#following = true;
	}

	#moveTo(index: number, total: number, height: number): void {
		const last = Math.max(0, total - height);
		const next = Math.max(0, Math.min(last, index));
		this.#top = next;
		this.#following = next >= last;
	}
}
