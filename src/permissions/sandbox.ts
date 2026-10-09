import type { SandboxMode } from '../config/schema.ts';
import { isWithin } from '../util/paths.ts';
import type { Decision } from './engine.ts';

/**
 * 沙箱:对文件访问施加硬边界。
 *
 * 语义定义:
 * - off:不限制;
 * - workspace:写操作限制在工作区内,读不限制;
 * - read-only:禁止一切写操作,读不限制。
 * 沙箱与规则引擎相互独立:沙箱是硬边界(直接 deny),规则是细粒度策略。
 *
 * 边界说明:沙箱只约束**文件类工具**(read/write/edit/glob/grep 的路径参数);
 * bash 不在其内——任意命令都可能写文件,静态判定做不到可靠,故交给 [permissions]
 * 的规则表达(例如 deny = ["bash(rm *)"])。需要绝对只读时,除设 sandbox 外还应
 * 用规则限制 bash。
 *
 * 路径契约:构造时的 workspace 与 checkPath 收到的 path 都必须是**真实路径**
 * (符号链接已解析)。两侧都按真实路径比较,区内的符号链接才不能把操作引到区外,
 * 而工作区自身是符号链接时也不会被误判为越界。解析由调用方在进沙箱前完成——
 * 这里不做任何文件系统访问。
 */
export class Sandbox {
  readonly mode: SandboxMode;
  readonly workspace: string;

  constructor(mode: SandboxMode, workspace: string) {
    this.mode = mode;
    this.workspace = workspace;
  }

  /** 检查文件操作;返回 null 表示无异议。 */
  checkPath(action: 'read' | 'write', path: string): Decision | null {
    if (this.mode === 'off') {
      return null;
    }
    if (action === 'write') {
      if (this.mode === 'read-only') {
        return { verdict: 'deny', reason: 'sandbox = read-only:禁止一切写操作' };
      }
      if (!isWithin(this.workspace, path)) {
        return { verdict: 'deny', reason: 'sandbox = workspace:写操作被限制在工作区内' };
      }
    }
    return null;
  }
}
