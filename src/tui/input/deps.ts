/**
 * 输入分发与各输入域共用的环境。
 *
 * 单独成文件是为了断开循环引用：dispatch 导入各域处理器，各域又需要 dispatch 的
 * 参数类型。类型只在这里定义，依赖方向就只剩一维。
 */
export interface InputDeps {
	readonly render: () => void;
	readonly onCtrlC: () => void;
	/** 直接收尾退出；启动期的信任页用它，那里没有需要二次确认的会话内容 */
	readonly cleanup: () => void;
}
