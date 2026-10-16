/**
 * 终端构件库。
 *
 * 这是产品赖以构建的基础设施，不是可替换的能力：终端渲染没有第二种实现，所以它留在宿主。
 * 交互形态本身（会话怎么显示、有哪些命令）属于产品界面，由界面插件实现，通过 frontend.ts
 * 的接缝接进来。
 */

export * from "./frontend.ts";
export * from "./input/editor.ts";
export * from "./input/keys.ts";
export * from "./screen/region.ts";
export * from "./screen/style.ts";
export * from "./terminal/terminal.ts";
export * from "./text/line.ts";
export * from "./text/truncate.ts";
export * from "./text/width.ts";
export * from "./text/wrap.ts";
export * from "./widgets/box.ts";
export * from "./widgets/spinner.ts";
