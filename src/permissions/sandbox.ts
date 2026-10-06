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
