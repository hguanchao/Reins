import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { createAgentRuntime, type AgentRuntime } from '../agent/run.ts';
import { findModelTarget, loadCatalogFile } from '../catalog/load.ts';
import type { Catalog } from '../catalog/schema.ts';
import {
  CHAT_COMMANDS,
  CHAT_COMMAND_DESCRIPTIONS,
  CHAT_HELP_TEXT,
  parseChatCommand,
} from '../cli/commands/chat-commands.ts';
import { latestSessionFile, listSessionSummaries, resolveSessionFile } from '../cli/commands/sessions.ts';
import { ignoredNotice } from '../cli/trust.ts';
import { ensureHomeConfig } from '../config/ensure.ts';
import { loadLayeredConfig } from '../config/layers.ts';
import { isReasoningEffort, REASONING_EFFORTS, type Config, type ReasoningEffort } from '../config/schema.ts';
import { recordTrust, resolveProjectTrust, type TrustResolution } from '../config/trust.ts';
import { existingProjectDocs } from '../context/agents-md.ts';
import type { ToolCall, Usage } from '../llm/types.ts';
import { promptTokens } from '../llm/usage.ts';
import { approvalGrant, type Approver } from '../permissions/approval.ts';
import type { Decision } from '../permissions/engine.ts';
import type { RuleTarget } from '../permissions/rules.ts';
import type { AgentUi } from '../ui/printer.ts';
import { sanitizeTerminalText } from '../util/ansi.ts';
import { describeError } from '../util/errors.ts';
import { readGitBranch } from '../util/git.ts';
import { absolutize, reinsHome } from '../util/paths.ts';
import type { CommandIo, ParsedArgs } from '../cli/args.ts';
import {
  contentHeight,
  createBlockRenderer,
  noticeDismissesWelcome,
  renderTrustPage,
  renderWindow,
  scrollWindow,
  summarizeToolArgs,
  type NoticeLevel,
  type RenderContext,
  type ScrollBlock,
} from './blocks.ts';
import {
  centerVertically,
  COMPLETION_MENU_ROWS,
  completionMenu,
  inputBoxFrame,
  inputBoxLine,
  inputBoxRowRange,
  moveApprovalIndex,
  movePickerIndex,
  overlayLines,
  paintSlashCommand,
  renderApprovalOptions,
  renderScrollbarLine,
  scrollbarGeometry,
  splitPathLabel,
  type MenuRow,
} from './chrome.ts';
import { createFileIndex, needsFileScan, type FileIndex } from './files.ts';
import { InputEditor } from './editor.ts';
import { createKeyDecoder, type TuiKey } from './keys.ts';
import { codePointWidth, padAnsi, softWrapRows, truncatePlain, visibleWidth, visualRowContains } from './layout.ts';
import { Terminal } from './screen.ts';
import { renderStatusBar, type StatusBarInfo } from './status.ts';
import { createTheme, symbols, type Theme } from './theme.ts';
import { Viewer } from './viewer.ts';

/**
 * TUI 应用:两区域(main / footer)全屏交互。
 *
 * 设计意图:事件驱动——按键事件与代理事件都只更新状态并标脏,
 * 渲染器按帧差分输出;纯文本模式保留在 chat --plain。
 */

const TICK_MS = 250;
const RENDER_DEBOUNCE_MS = 16;
const MAX_INPUT_LINES = 4;
const MIN_COLS = 40;
const MIN_ROWS = 12;
/** 输入流静止多久后把挂起的孤立 Esc 兜底吐出。 */
const ESC_FLUSH_MS = 50;

/**
 * 选中后直接进入二级菜单的命令。
 *
 * 它们的菜单就是「无参数用法」,回显到输入框只会多一次回车;菜单打开时
 * 行内不可能有参数(斜杠补全不覆盖带空格的行),所以直接按无参数执行。
 */
const SUBMENU_COMMANDS = new Set(['/model', '/effort', '/sessions']);
/** 分支名的重读间隔:只为状态栏一行字,不值得每次渲染都读盘。 */
const BRANCH_TTL_MS = 5000;

/**
 * 作用于输入框的按键。
 *
 * 收到这些键即视为输入框重新获得焦点:鼠标点到别处会让输入框失焦,但键盘输入
 * 始终进输入框,若不重新聚焦就会出现「有内容、却既没焦点也没光标」的矛盾状态。
 */
const INPUT_BOX_KEYS: ReadonlySet<TuiKey['type']> = new Set([
  'text',
  'paste',
  'enter',
  'ctrl-j',
  'tab',
  'backspace',
  'delete',
  'left',
  'right',
  'home',
  'end',
  'up',
  'down',
  'ctrl-u',
  'ctrl-w',
]);

export interface TuiAppOptions {
  home: string;
  workspace: string;
  resumeFile?: string;
  /** 命令行 --trust:跳过信任询问并记下信任。 */
  forceTrust?: boolean;
}

/** 组装并启动 TUI 会话;返回进程退出码。 */
export async function startTui(args: ParsedArgs, io: CommandIo, home = reinsHome()): Promise<number> {
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();

  const ensured = await ensureHomeConfig(home);
  if (ensured.created.length > 0) {
    io.err(`已创建默认配置:${ensured.created.join('、')}`);
    io.err('提示:请编辑 providers.json 填入你的端点与密钥。');
  }

  let resumeFile: string | undefined;
  try {
    const flag = args.flags['resume'];
    if (flag !== undefined) {
      resumeFile =
        flag === true || flag === ''
          ? await latestSessionFile(home, workspace)
          : await resolveSessionFile(home, String(flag), workspace);
      if (resumeFile === undefined) {
        io.err('未找到可恢复的会话,将开始新会话。');
      }
    }
  } catch (error) {
    io.err(`警告:${describeError(error)}`);
  }

  const app = new TuiApp({
    home,
    workspace,
    resumeFile,
    forceTrust: args.flags['trust'] === true,
  });
  return await app.start();
}

export class TuiApp implements AgentUi {
  private readonly options: TuiAppOptions;
  private readonly terminal: Terminal;
  private readonly editor: InputEditor;
  private readonly fileIndex: FileIndex;
  private readonly viewer = new Viewer();
  private readonly decoder = createKeyDecoder();
  private readonly blocks: ScrollBlock[] = [];
  private readonly toolStartTimes = new Map<ScrollBlock, number>();
  private readonly alwaysAllow = new Set<string>();

  private readonly renderContext: RenderContext;
  private renderer: ReturnType<typeof createBlockRenderer>;

  private runtime: AgentRuntime | undefined;
  private catalog: Catalog | undefined;
  private currentConfig: Config | undefined;
  /** /effort 的会话内覆盖;undefined = 跟随配置文件。单独留存,保证 /model、/new 重建后仍然生效。 */
  private effortOverride: ReasoningEffort | undefined;

  private running = false;
  private focused = true;
  private runController: AbortController | undefined;
  private spinnerIndex = 0;

  /** 最近一轮模型调用的用量:状态栏据此显示上下文占用与缓存命中率。 */
  private lastUsage: Usage | undefined;
  /** 当前分支;不是 git 仓库时为 undefined。分支会被外部 git 操作改掉,故按 TTL 重读。 */
  private branch: string | undefined;
  private branchCheckedAt = 0;
  private branchInFlight = false;

  private scrollTop = 0;
  private follow = true;
  private lastMainHeight = 1;
  private lastMaxTop = 0;

  private approvalCard: { target: RuleTarget; decision: Decision } | undefined;
  private approvalIndex = 0;
  private approvalResolve: ((verdict: 'allow' | 'deny') => void) | undefined;
  /** 命令子菜单(/model、/effort、/sessions 无参数时弹出):模态,回车执行选中项。 */
  private picker:
    | {
        kind: 'model' | 'effort' | 'sessions';
        rows: MenuRow[];
        /** 与 rows 一一对应的载荷,回车时交给对应命令执行。 */
        payloads: string[];
        index: number;
      }
    | undefined;
  /** 目录信任判定结果;启动时先于会话确定。 */
  private trust: TrustResolution | undefined;
  /** 待回答的信任页;有值时整屏只显示它。docs 是会被注入的说明文件。 */
  private trustPrompt:
    | { resolution: TrustResolution; docs: string[]; resolve: (accepted: boolean) => void }
    | undefined;
  /** 信任页当前选中的选项下标(0 = 信任并继续,1 = 退出)。 */
  private trustIndex = 0;

  private renderTimer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private escFlushTimer: NodeJS.Timeout | undefined;
  private readonly onData = (chunk: Buffer): void => {
    this.dispatch(this.decoder.feed(chunk));
    if (this.decoder.hasPending()) {
      if (this.escFlushTimer === undefined) {
        this.escFlushTimer = setTimeout(() => {
          this.escFlushTimer = undefined;
          this.dispatch(this.decoder.flush());
        }, ESC_FLUSH_MS);
      }
      return;
    }
    if (this.escFlushTimer !== undefined) {
      clearTimeout(this.escFlushTimer);
      this.escFlushTimer = undefined;
    }
  };
  private exiting = false;
  private cleanedUp = false;
  private closed: (() => void) | undefined;

  constructor(options: TuiAppOptions) {
    this.options = options;
    this.terminal = new Terminal(process.stdout, process.stdin);
    this.renderContext = { spinner: symbols.spinner[0] as string, theme: createTheme() };
    this.renderer = createBlockRenderer(this.renderContext);
    this.fileIndex = createFileIndex(options.workspace);
    this.editor = new InputEditor({ commands: CHAT_COMMANDS, files: () => this.fileIndex.list() });
  }

  async start(): Promise<number> {
    this.terminal.enter();
    process.stdin.on('data', this.onData);
    process.stdout.on('resize', this.onResize);
    const stopped = new Promise<void>((resolve) => {
      this.closed = resolve;
    });
    const stop = (): void => {
      this.requestExit();
      this.cleanupTerminal();
    };
    const fatal = (error: unknown): void => {
      try {
        process.stderr.write(`错误:${describeError(error)}\n`);
      } catch {
        // 终端已损坏时不再尝试输出,优先恢复模式
      }
      process.exitCode = 1;
      stop();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    try {
      // 信任先于会话:未信任就不加载项目层配置、不注入项目说明文件
      if (!(await this.resolveTrust())) {
        return 1;
      }
      if (this.exiting) {
        return 130;
      }

      this.push({ kind: 'welcome' });
      // 预热文件索引:首次按 @ 就能直接出候选,不必等后台扫描完
      void this.fileIndex.refresh().catch(() => undefined);
      try {
        await this.startup();
      } catch (error) {
        this.pushNotice(`配置未就绪:${describeError(error)}(修复后可输入任务重试)`, 'warn');
      }
      if (this.exiting) {
        return 130;
      }

      this.ticker = setInterval(() => {
        if (this.running) {
          this.spinnerIndex += 1;
          this.renderContext.spinner = symbols.spinner[
            this.spinnerIndex % symbols.spinner.length
          ] as string;
          this.scheduleRender();
        }
      }, TICK_MS);
      this.scheduleRender();

      await stopped;
      return process.exitCode === 1 ? 1 : 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('uncaughtException', fatal);
      process.off('unhandledRejection', fatal);
      this.cleanupTerminal();
      await this.runtime?.close().catch(() => undefined);
    }
  }

  /** 退出清理:先停定时器,再恢复终端;重复调用不重复发送控制序列。 */
  private cleanupTerminal(): void {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.escFlushTimer !== undefined) {
      clearTimeout(this.escFlushTimer);
      this.escFlushTimer = undefined;
    }
    process.stdout.off('resize', this.onResize);
    process.stdin.off('data', this.onData);
    this.terminal.leave();
  }

  /**
   * 解析目录信任;需要询问时渲染信任页并等 y/n。
   *
   * 返回 false 表示用户拒绝信任,调用方应直接退出——不在受限状态下继续。
   */
  private async resolveTrust(): Promise<boolean> {
    const resolution = await resolveProjectTrust({
      home: this.options.home,
      workspace: this.options.workspace,
      interactive: process.stdin.isTTY === true,
      force: this.options.forceTrust === true,
      prompt: (pending) => this.askTrust(pending),
      record: (pattern) => recordTrust(this.options.home, pattern),
    });
    this.trust = resolution;
    if (resolution.reason === 'declined') {
      return false;
    }
    // 刚按下 y 不必再复述一遍结果;只在项目内容确实被忽略时才提示
    const ignored = await ignoredNotice(resolution);
    if (ignored !== undefined) {
      this.pushNotice(ignored, 'warn');
    }
    return true;
  }

  /** 信任页:先取会被注入的说明文件,再挂起一个 Promise 等按键回答。 */
  private async askTrust(resolution: TrustResolution): Promise<boolean> {
    const docs = (await existingProjectDocs(resolution.key)).map((file) => basename(file));
    return await new Promise<boolean>((resolve) => {
      this.trustIndex = 0;
      this.trustPrompt = { resolution, docs, resolve };
      this.scheduleRender();
    });
  }

  /** 信任页按键:只有左右切换、回车确认与 y/n 快捷键;Ctrl+C 作兜底退出。 */
  private handleTrustKey(key: TuiKey): void {
    if (this.trustPrompt === undefined) {
      return;
    }
    const count = 2;
    // 到两端就停住不回环:绕圈会让人在连按时错过另一头的选项
    if (key.type === 'left') {
      this.trustIndex = Math.max(0, this.trustIndex - 1);
      this.scheduleRender();
      return;
    }
    if (key.type === 'right') {
      this.trustIndex = Math.min(count - 1, this.trustIndex + 1);
      this.scheduleRender();
      return;
    }
    if (key.type === 'enter') {
      this.finishTrust(this.trustIndex === 0);
      return;
    }
    if (key.type === 'text') {
      const first = key.text.trim().toLowerCase()[0];
      if (first === 'y') {
        this.finishTrust(true);
        return;
      }
      if (first === 'n') {
        this.finishTrust(false);
        return;
      }
    }
    // 兜底退出:raw 模式下 Ctrl+C 不产生信号,不接住会把用户困在信任页
    if (key.type === 'ctrl-c') {
      this.finishTrust(false);
    }
  }

  private finishTrust(accepted: boolean): void {
    const pending = this.trustPrompt;
    if (pending === undefined) {
      return;
    }
    this.trustPrompt = undefined;
    pending.resolve(accepted);
    this.scheduleRender();
  }

  private dispatch(events: readonly TuiKey[]): void {
    for (const key of events) {
      this.handleKey(key);
      // 打字与粘贴都算「开始输入」:一有内容就让欢迎面板退场,不必等首条消息发出
      this.hideWelcomeOnInput();
    }
  }

  /** 输入是欢迎页退场的另一路信号;单向,清空输入也不找回来。警告/错误那一路见 pushNotice。 */
  private hideWelcomeOnInput(): void {
    if (this.editor.isEmpty) {
      return;
    }
    this.hideWelcome();
  }

  private hideWelcome(): void {
    const index = this.blocks.findIndex((block) => block.kind === 'welcome');
    if (index < 0) {
      return;
    }
    this.blocks.splice(index, 1);
    this.scheduleRender();
  }

  // —— AgentUi 事件(由代理循环驱动) ——

  onAssistantText(text: string): void {
    const clean = sanitizeTerminalText(text);
    const last = this.blocks[this.blocks.length - 1];
    if (last !== undefined && last.kind === 'assistant' && last.streaming) {
      last.text += clean;
    } else {
      this.blocks.push({ kind: 'assistant', text: clean, streaming: true });
    }
    this.scheduleRender();
  }

  onToolCall(call: ToolCall): void {
    const block: ScrollBlock = {
      kind: 'tool',
      name: call.name,
      summary: sanitizeTerminalText(summarizeToolArgs(call.arguments)),
      state: 'running',
    };
    this.blocks.push(block);
    this.toolStartTimes.set(block, Date.now());
    this.scheduleRender();
  }

  onToolResult(name: string, content: string, isError: boolean): void {
    const block = this.blocks.find(
      (item) => item.kind === 'tool' && item.state === 'running' && item.name === name,
    );
    if (block === undefined || block.kind !== 'tool') {
      return;
    }
    const started = this.toolStartTimes.get(block);
    const clean = sanitizeTerminalText(content);
    block.state = isError ? 'fail' : 'ok';
    block.elapsedMs = started !== undefined ? Date.now() - started : undefined;
    block.output = clean;
    if (isError) {
      block.detail = (clean.split('\n')[0] ?? '').trim();
    }
    this.toolStartTimes.delete(block);
    this.scheduleRender();
  }

  onNotice(message: string): void {
    this.pushNotice(message, 'info');
  }

  /** 每轮模型调用结束后上报用量:状态栏的上下文占用与缓存命中率取自最近一轮。 */
  onUsage(usage: Usage): void {
    this.lastUsage = usage;
    this.scheduleRender();
  }

  // —— 按键分发 ——

  private handleKey(key: TuiKey): void {
    if (this.exiting) {
      return;
    }
    if (key.type === 'focus-in' || key.type === 'focus-out') {
      this.focused = key.type === 'focus-in';
      this.scheduleRender();
      return;
    }
    if (key.type === 'mouse-down') {
      this.focused = this.isInputBoxRow(key.y);
      this.scheduleRender();
      return;
    }
    // 信任页先于一切:它决定后面加载什么配置
    if (this.trustPrompt !== undefined) {
      this.handleTrustKey(key);
      return;
    }
    if (this.approvalCard !== undefined) {
      this.handleApprovalKey(key);
      this.scheduleRender();
      return;
    }
    // 命令子菜单也是模态的:拦截所有按键,不让它们落进输入框
    if (this.picker !== undefined) {
      this.handlePickerKey(key);
      return;
    }
    if (this.viewer.isOpen) {
      this.handleViewerKey(key);
      this.scheduleRender();
      return;
    }
    // 输入类按键重新聚焦输入框(见 INPUT_BOX_KEYS 的说明)
    if (INPUT_BOX_KEYS.has(key.type)) {
      this.focused = true;
    }
    if (key.type === 'paste') {
      this.handlePaste(key.text);
      this.scheduleRender();
      return;
    }
    if (key.type === 'wheel') {
      this.scrollBy(key.delta);
      this.scheduleRender();
      return;
    }
    if (key.type === 'text') {
      this.editor.insert(key.text);
      this.maybeRefreshFileIndex();
      this.scheduleRender();
      return;
    }
    switch (key.type) {
      case 'ctrl-c':
        if (this.running) {
          this.interrupt();
        } else if (!this.editor.isEmpty) {
          this.editor.clear();
        } else {
          this.requestExit();
        }
        break;
      case 'escape':
        // Esc 优先收起补全菜单,其次中断/清空
        if (this.editor.completionState !== null) {
          this.editor.closeCompletion();
        } else if (this.running) {
          this.interrupt();
        } else if (!this.editor.isEmpty) {
          this.editor.clear();
        }
        break;
      case 'ctrl-d':
        if (!this.running && this.editor.isEmpty) {
          this.requestExit();
        }
        break;
      case 'enter':
        void this.submit().catch((error: unknown) => {
          this.pushNotice(`错误:${describeError(error)}`, 'error');
        });
        break;
      case 'ctrl-j':
        this.editor.insertNewline();
        break;
      case 'tab':
        this.editor.applyCompletion();
        break;
      case 'backspace':
        this.editor.backspace();
        break;
      case 'delete':
        this.editor.deleteForward();
        break;
      case 'left':
        this.editor.moveLeft();
        break;
      case 'right':
        // 光标在行尾且有灰色预选时,→ 先接受预选(同 shell 自动建议的肌肉记忆)
        if (this.editor.cursorAtEnd) {
          const ghost = this.ghostSuggestion();
          if (ghost !== undefined) {
            this.editor.insert(ghost);
            break;
          }
        }
        this.editor.moveRight();
        break;
      case 'home':
        this.editor.moveHome();
        break;
      case 'end':
        if (!this.follow) {
          this.follow = true;
        } else {
          this.editor.moveEnd();
        }
        break;
      case 'up':
        this.editor.moveUp();
        break;
      case 'down':
        this.editor.moveDown();
        break;
      case 'pageup':
        this.pageUp();
        break;
      case 'pagedown':
        this.pageDown();
        break;
      case 'ctrl-u':
        this.editor.clear();
        break;
      case 'ctrl-w':
        this.editor.deleteWordBackward();
        break;
      case 'ctrl-e':
        this.toggleToolExpand();
        break;
      case 'ctrl-o':
        this.toggleViewer();
        break;
      default:
        break;
    }
    this.scheduleRender();
  }

  private handleViewerKey(key: TuiKey): void {
    const rows = this.terminal.rows;
    switch (key.type) {
      case 'escape':
      case 'ctrl-c':
      case 'ctrl-o':
        this.viewer.close();
        return;
      case 'up':
        this.viewer.scroll(-1);
        return;
      case 'down':
        this.viewer.scroll(1);
        return;
      case 'pageup':
        this.viewer.pageUp(rows);
        return;
      case 'pagedown':
        this.viewer.pageDown(rows);
        return;
      case 'home':
        this.viewer.home();
        return;
      case 'end':
        this.viewer.end();
        return;
      case 'wheel':
        this.viewer.scroll(key.delta);
        return;
      case 'text': {
        const lower = key.text.toLowerCase();
        if (lower === 'q') {
          this.viewer.close();
        } else if (lower === 'n') {
          this.viewer.step(1, this.blocks.length);
        } else if (lower === 'p') {
          this.viewer.step(-1, this.blocks.length);
        }
        return;
      }
      default:
        return;
    }
  }

  private handlePaste(text: string): void {
    const lines = this.editor.insertRaw(text);
    if (lines > 1) {
      this.pushNotice(`已粘贴 ${lines} 行 · 回车发送`, 'info');
    }
    this.maybeRefreshFileIndex();
  }

  /**
   * 光标处于 @ 词条内且文件快照过期时,后台重新扫描工作区。
   *
   * 触发条件由 needsFileScan 给出:它只看输入文本,不看已有候选,
   * 否则索引为空时永远等不到第一次扫描。
   */
  private maybeRefreshFileIndex(): void {
    if (!needsFileScan(this.editor.mentionQuery(), this.fileIndex.stale())) {
      return;
    }
    void this.fileIndex
      .refresh()
      .then(() => {
        this.editor.refreshCompletion();
        this.scheduleRender();
      })
      .catch(() => undefined);
  }

  private toggleToolExpand(): void {
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      const block = this.blocks[index];
      if (block !== undefined && block.kind === 'tool') {
        block.expanded = !(block.expanded === true);
        return;
      }
    }
    this.pushNotice('没有可展开的工具输出', 'info');
  }

  private toggleViewer(): void {
    if (this.viewer.isOpen) {
      this.viewer.close();
      return;
    }
    let target = -1;
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      const block = this.blocks[index];
      if (block !== undefined && block.kind === 'tool' && block.output !== undefined) {
        target = index;
        break;
      }
    }
    if (target === -1 && this.blocks.length > 0) {
      target = this.blocks.length - 1;
    }
    if (target === -1) {
      this.pushNotice('还没有可查看的内容', 'info');
      return;
    }
    this.viewer.open(target);
  }

  private scrollBy(delta: number): void {
    if (delta < 0) {
      this.follow = false;
      this.scrollTop = Math.max(0, this.scrollTop + delta);
      return;
    }
    const target = this.scrollTop + delta;
    if (target >= this.lastMaxTop) {
      this.follow = true;
    } else {
      this.scrollTop = target;
    }
  }

  private interrupt(): void {
    this.runController?.abort();
    this.pushNotice('中断中…', 'warn');
  }

  private pageUp(): void {
    const page = Math.max(1, this.lastMainHeight - 1);
    this.follow = false;
    this.scrollTop = Math.max(0, this.scrollTop - page);
  }

  private pageDown(): void {
    const page = Math.max(1, this.lastMainHeight - 1);
    const target = this.scrollTop + page;
    if (target >= this.lastMaxTop) {
      this.follow = true;
    } else {
      this.scrollTop = target;
    }
  }

  // —— 提交与命令 ——

  private async submit(): Promise<void> {
    if (this.running) {
      return;
    }
    // 菜单打开时回车只应用选中项,不直接发送,免得误发没确认的命令;
    // 例外是带二级菜单的命令:清空输入直接进菜单,不回显命令
    const completion = this.editor.completionState;
    if (completion !== null) {
      const item = completion.items[completion.index];
      if (item !== undefined && SUBMENU_COMMANDS.has(item)) {
        this.editor.clear();
        this.scheduleRender();
        if (item === '/model') {
          await this.commandModel(undefined);
        } else if (item === '/effort') {
          this.commandEffort(undefined);
        } else {
          await this.commandResume(undefined);
        }
        return;
      }
      this.editor.applyCompletion();
      this.scheduleRender();
      return;
    }
    const text = this.editor.submit();
    if (text.trim() === '') {
      this.scheduleRender();
      return;
    }
    this.scheduleRender();
    const command = parseChatCommand(text);
    switch (command.type) {
      case 'exit':
        this.requestExit();
        return;
      case 'empty':
        return;
      case 'help':
        this.pushNotice(CHAT_HELP_TEXT, 'info');
        break;
      case 'mcp':
        this.printMcp();
        break;
      case 'new':
        await this.commandNew();
        break;
      case 'compact':
        await this.commandCompact();
        break;
      case 'model':
        await this.commandModel(command.target);
        break;
      case 'effort':
        this.commandEffort(command.value);
        break;
      case 'resume':
        await this.commandResume(command.id);
        break;
      case 'prompt':
        await this.runPrompt(command.text);
        break;
    }
  }

  private printMcp(): void {
    if (this.runtime === undefined) {
      this.pushNotice('(尚未就绪)', 'warn');
      return;
    }
    if (this.runtime.mcp.length === 0) {
      this.pushNotice('未配置 MCP 服务器(见 config.toml 的 [mcp_servers])。', 'info');
      return;
    }
    for (const status of this.runtime.mcp) {
      this.pushNotice(
        status.ok ? `${status.name} · ${status.toolCount ?? 0} 个工具` : `${status.name} · ${status.error ?? '未知原因'}`,
        status.ok ? 'info' : 'warn',
      );
    }
  }

  private async commandCompact(): Promise<void> {
    try {
      const runtime = await this.ensureRuntime();
      const done = await runtime.agent.compact();
      if (!done) {
        this.pushNotice('当前没有可压缩的内容。', 'info');
      }
    } catch (error) {
      this.pushNotice(`错误:${describeError(error)}`, 'error');
    }
  }

  private async commandModel(target: string | undefined): Promise<void> {
    if (this.catalog === undefined) {
      this.pushNotice('(尚未就绪:产商目录未加载)', 'warn');
      return;
    }
    if (target === undefined) {
      const rows: MenuRow[] = [];
      let current = 0;
      for (const [name, spec] of Object.entries(this.catalog.providers)) {
        for (const model of spec.models) {
          const active =
            this.currentConfig?.provider === name && this.currentConfig.model === model.id;
          if (active) {
            current = rows.length;
          }
          rows.push({ label: `${name}/${model.id}`, detail: active ? '当前使用' : undefined });
        }
      }
      this.openPicker('model', rows, current);
      return;
    }
    const match = findModelTarget(this.catalog, target);
    if (match.kind === 'found') {
      try {
        await this.rebuild({ provider: match.provider, model: match.modelId });
        this.pushNotice(`已切换模型:${match.provider}/${match.modelId}`, 'info');
      } catch (error) {
        this.pushNotice(`错误:${describeError(error)}`, 'error');
      }
    } else if (match.kind === 'ambiguous') {
      this.pushNotice('匹配到多个模型,请带上 provider:', 'info');
      for (const option of match.options) {
        this.pushNotice(`  ${option.provider}/${option.modelId}`, 'info');
      }
    } else {
      this.pushNotice(`未找到模型:${target}(用 /model 查看可选)`, 'warn');
    }
  }

  /**
   * /effort:查看或切换思考强度。
   *
   * 切换时原地写入当前配置:代理循环每轮都从创建时持有的 config 引用读取该值,
   * 没必要为这一个字段重建运行时、把 MCP 连接白白断一遍。
   */
  private commandEffort(value: string | undefined): void {
    if (value === undefined) {
      const details: Record<ReasoningEffort, string> = {
        off: '关闭',
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '超高',
        max: '极致',
      };
      const rows: MenuRow[] = REASONING_EFFORTS.map((level) => ({
        label: level,
        detail: details[level],
      }));
      const current = this.currentConfig?.reasoningEffort;
      this.openPicker('effort', rows, current !== undefined ? REASONING_EFFORTS.indexOf(current) : 0);
      return;
    }
    if (!isReasoningEffort(value)) {
      this.pushNotice(`未知思考强度:${value}(可选:${REASONING_EFFORTS.join('|')})`, 'warn');
      return;
    }
    this.effortOverride = value;
    if (this.currentConfig !== undefined) {
      this.currentConfig.reasoningEffort = value;
    }
    this.pushNotice(`思考强度已切换:${value}`, 'info');
  }

  private async commandNew(): Promise<void> {
    try {
      await this.rebuild({ freshSession: true });
      this.pushNotice(`已开始新会话:${this.runtime?.session.id ?? ''}`, 'info');
    } catch (error) {
      this.pushNotice(`错误:${describeError(error)}`, 'error');
    }
  }

  private async commandResume(id: string | undefined): Promise<void> {
    if (id === undefined) {
      const summaries = await listSessionSummaries(this.options.home);
      if (summaries.length === 0) {
        this.pushNotice('还没有任何会话。', 'info');
        return;
      }
      const rows: MenuRow[] = summaries.map((summary) => ({
        label: summary.sessionId,
        detail: `${summary.createdAt.replace('T', ' ').slice(0, 19)}  ${summary.preview}`,
      }));
      this.openPicker('sessions', rows);
      return;
    }
    try {
      await this.rebuild({ sessionFile: await resolveSessionFile(this.options.home, id, this.options.workspace) });
      this.pushNotice(`已恢复会话:${this.runtime?.session.id ?? ''}`, 'info');
    } catch (error) {
      this.pushNotice(`错误:${describeError(error)}`, 'error');
    }
  }

  private async runPrompt(text: string): Promise<void> {
    if (this.running) {
      return;
    }
    // 通常欢迎面板在第一个字符时就退了;这里兜住直接提交的路径
    this.hideWelcome();
    this.push({ kind: 'user', text });
    this.running = true;
    this.follow = true;
    const controller = new AbortController();
    this.runController = controller;
    this.scheduleRender();
    try {
      const runtime = await this.ensureRuntime();
      await runtime.agent.run(text, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.pushNotice(`错误:${describeError(error)}`, 'error');
        this.pushNotice('(修复配置后直接输入任务即可重试)', 'info');
      }
    } finally {
      this.running = false;
      this.runController = undefined;
      this.markRunStopped(controller.signal.aborted);
      this.scheduleRender();
    }
  }

  // —— 运行时装配 ——

  private async startup(): Promise<void> {
    const layered = await loadLayeredConfig({
      home: this.options.home,
      cwd: this.options.workspace,
      projectLayer: this.projectLayer(),
    });
    this.currentConfig = this.applyEffort(layered.config);
    this.applyTheme();
    this.catalog = await loadCatalogFile(join(this.options.home, 'providers.json'));
    this.runtime = await createAgentRuntime({
      config: this.currentConfig,
      catalog: this.catalog,
      workspace: this.options.workspace,
      home: this.options.home,
      ui: this,
      sessionFile: this.options.resumeFile,
      projectTrusted: this.projectAllowed(),
      approval: { approver: this.approver },
    });
    this.options.resumeFile = undefined;
  }

  /** 项目层是否可用;未解析出信任结果时按不可用处理(fail-closed)。 */
  private projectLayer(): 'allow' | 'ignore' {
    return this.projectAllowed() ? 'allow' : 'ignore';
  }

  private projectAllowed(): boolean {
    return this.trust?.projectAllowed === true;
  }

  private async rebuild(options: {
    provider?: string;
    model?: string;
    sessionFile?: string;
    freshSession?: boolean;
  }): Promise<void> {
    const layered = await loadLayeredConfig({
      home: this.options.home,
      cwd: this.options.workspace,
      projectLayer: this.projectLayer(),
    });
    this.currentConfig = this.applyEffort({
      ...layered.config,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    this.applyTheme();
    this.catalog = await loadCatalogFile(join(this.options.home, 'providers.json'));
    const sessionFile =
      options.freshSession === true ? undefined : (options.sessionFile ?? this.runtime?.session.path);
    await this.runtime?.close();
    this.runtime = undefined;
    // 换会话(或换模型)后上一轮的用量不再代表当前上下文,先清掉避免显示残留数字
    this.lastUsage = undefined;
    this.runtime = await createAgentRuntime({
      config: this.currentConfig,
      catalog: this.catalog,
      workspace: this.options.workspace,
      home: this.options.home,
      ui: this,
      sessionFile,
      projectTrusted: this.projectAllowed(),
      approval: { approver: this.approver },
    });
  }

  /** 装配生效配置:/effort 的会话内覆盖要压过配置文件,且在重建后继续生效。 */
  private applyEffort(config: Config): Config {
    return this.effortOverride !== undefined
      ? { ...config, reasoningEffort: this.effortOverride }
      : config;
  }

  private async ensureRuntime(): Promise<AgentRuntime> {
    if (this.runtime !== undefined) {
      return this.runtime;
    }
    await this.startup();
    if (this.runtime === undefined) {
      throw new Error('运行时未就绪');
    }
    return this.runtime;
  }

  private readonly approver: Approver = {
    ask: (target, decision) => this.askApproval(target, decision),
  };

  private askApproval(target: RuleTarget, decision: Decision): Promise<'allow' | 'deny'> {
    if (this.alwaysAllow.has(approvalGrant(target, decision).key)) {
      return Promise.resolve('allow');
    }
    // 审批需要立即关注:把查看器收起,让审批卡片可见
    this.viewer.close();
    this.approvalIndex = 0;
    this.approvalCard = { target, decision };
    this.scheduleRender();
    return new Promise<'allow' | 'deny'>((resolve) => {
      this.approvalResolve = resolve;
    });
  }

  private handleApprovalKey(key: TuiKey): void {
    if (this.approvalCard === undefined || this.approvalResolve === undefined) {
      return;
    }
    const moved = moveApprovalIndex(key, this.approvalIndex);
    if (moved !== undefined) {
      this.approvalIndex = moved;
      this.scheduleRender();
      return;
    }
    if (key.type === 'enter') {
      this.finishApproval(this.approvalIndex);
      return;
    }
    if (key.type === 'text' && ['y', 'a', 'n'].includes(key.text.toLowerCase())) {
      const choice = key.text.toLowerCase();
      this.finishApproval(choice === 'y' ? 0 : choice === 'a' ? 1 : 2);
      return;
    }
    if (key.type === 'escape' || key.type === 'ctrl-c') {
      this.finishApproval(2);
    }
  }

  private finishApproval(index: number): void {
    const card = this.approvalCard;
    const resolve = this.approvalResolve;
    if (card === undefined || resolve === undefined) {
      return;
    }
    if (index === 1) {
      this.alwaysAllow.add(approvalGrant(card.target, card.decision).key);
    }
    this.approvalCard = undefined;
    this.approvalResolve = undefined;
    resolve(index === 2 ? 'deny' : 'allow');
  }

  /** 打开命令子菜单:标签即载荷,回车时交给对应命令执行。 */
  private openPicker(kind: 'model' | 'effort' | 'sessions', rows: MenuRow[], index = 0): void {
    this.picker = { kind, rows, payloads: rows.map((row) => row.label), index };
    this.scheduleRender();
  }

  /** 命令子菜单按键:上下选择,回车执行选中项,Esc 取消;模态,其余键一律忽略。 */
  private handlePickerKey(key: TuiKey): void {
    const picker = this.picker;
    if (picker === undefined) {
      return;
    }
    const moved = movePickerIndex(key, picker.index, picker.rows.length);
    if (moved !== undefined) {
      picker.index = moved;
      this.scheduleRender();
      return;
    }
    if (key.type === 'enter') {
      const value = picker.payloads[picker.index];
      this.picker = undefined;
      this.scheduleRender();
      if (value === undefined) {
        return;
      }
      if (picker.kind === 'model') {
        void this.commandModel(value);
      } else if (picker.kind === 'effort') {
        this.commandEffort(value);
      } else {
        void this.commandResume(value);
      }
      return;
    }
    // Ctrl+C 在这里是收起菜单而不是退出:和审批卡一样,别让兜底键夹带副作用
    if (key.type === 'escape' || key.type === 'ctrl-c') {
      this.picker = undefined;
      this.scheduleRender();
    }
  }

  // —— 渲染 ——

  private scheduleRender(): void {
    if (this.exiting || this.renderTimer !== undefined) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      try {
        this.render();
      } catch (error) {
        this.pushNotice(`渲染失败:${describeError(error)}`, 'error');
        this.requestExit();
      }
    }, RENDER_DEBOUNCE_MS);
  }

  private readonly onResize = (): void => {
    this.terminal.invalidate();
    this.scheduleRender();
  };

  private render(): void {
    const cols = this.terminal.columns;
    const rows = this.terminal.rows;
    // 状态栏要显示分支,而分支会被外部 git 操作改掉:按 TTL 重读,读到了再重绘
    this.refreshBranch();
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      this.terminal.render([truncatePlain(`窗口太小,请调整终端尺寸(至少 ${MIN_COLS}×${MIN_ROWS})`, cols)], null);
      return;
    }
    // 信任页独占整屏:它决定后面加载哪些配置,先问清楚再谈别的
    if (this.trustPrompt !== undefined) {
      this.terminal.render(this.renderTrustFrame(cols, rows), null);
      return;
    }
    // 全屏查看器独占整屏;返回时靠帧差分自然重绘
    if (this.viewer.isOpen) {
      this.terminal.render(this.viewer.render(this.blocks, cols, rows, this.renderContext), null);
      return;
    }
    const theme = this.renderContext.theme;
    const footer = this.renderFooter(cols);
    // 顶部无 header、底部无分隔线:整屏只有内容区与输入区,行数全部给内容
    const mainHeight = Math.max(1, rows - footer.lines.length);
    // 右侧最后一列固定留给滚动条,内容按窄一列排版
    const width = cols - 1;
    // 欢迎面板独占屏幕时垂直居中;一旦有对话内容就回到顶部对齐,避免最新一行随长度跳动
    const welcome = this.blocks.length === 1 && this.blocks[0]?.kind === 'welcome' ? this.blocks[0] : undefined;
    let content: string[];
    let total: number;
    if (welcome !== undefined) {
      this.scrollTop = 0;
      content = centerVertically(this.renderer.render(welcome, width), mainHeight);
      total = content.length;
      this.renderer.release(this.blocks, this.blocks);
    } else {
      // 先取各区块行数(离屏区块只剩行数,没有渲染行),据此定视口,再物化视口内的区块
      const heights = this.blocks.map((block) => this.renderer.height(block, width));
      total = contentHeight(heights);
      const maxTop = Math.max(0, total - mainHeight);
      if (this.follow) {
        this.scrollTop = maxTop;
      }
      const top = Math.min(this.scrollTop, maxTop);
      this.scrollTop = top;
      const window = scrollWindow(heights, top, mainHeight);
      content = renderWindow(this.blocks, window, (block) => this.renderer.render(block, width));
      this.renderer.release(this.blocks, this.blocks.slice(window.start, window.end + 1));
    }
    this.lastMainHeight = mainHeight;
    this.lastMaxTop = Math.max(0, total - mainHeight);
    const main = content.slice(0, mainHeight);
    while (main.length < mainHeight) {
      main.push('');
    }
    const bar = scrollbarGeometry(this.scrollTop, mainHeight, total);
    const scrollbarLines = main.map((_, index) => renderScrollbarLine(index, bar, theme));
    const mainLines = main.map((line, index) => `${padAnsi(line, cols - 1)}${scrollbarLines[index] ?? ''}`);
    const menuWidth = cols - 1;
    const completion = this.renderCompletionMenu(menuWidth, mainHeight);
    const visibleMainLines = overlayLines(mainLines, completion, scrollbarLines);
    const lines = [...visibleMainLines, ...footer.lines];
    const cursor =
      footer.cursor === undefined
        ? null
        : { row: mainHeight + footer.cursor.line, col: footer.cursor.column };
    this.terminal.render(lines, cursor);
  }

  /**
   * 信任页整屏:垂直居中的正文 + 分隔线下方居中的选项。
   *
   * 页脚与命令审批卡片等高(含分隔线共 4 行),选项落在分隔线以下三行的中间,
   * 上下各留一行。正文过长(矮终端)时保留顶部——提问与路径比清单更要紧。
   */
  private renderTrustFrame(cols: number, rows: number): string[] {
    const theme = this.renderContext.theme;
    const pending = this.trustPrompt;
    if (pending === undefined) {
      return [];
    }
    const separator = theme.paint.separator(symbols.separator.repeat(cols));
    const options = [theme.paint.ok('[y] 信任并继续'), theme.paint.fail('[n] 退出')];
    const optionsText = renderApprovalOptions(options, this.trustIndex, theme);
    const optionsPad = Math.max(0, Math.floor((cols - visibleWidth(optionsText)) / 2));
    // 分隔线以下三行:选项居中,上下各留一行
    const footer = ['', ' '.repeat(optionsPad) + optionsText, ''];
    const body = renderTrustPage(cols, theme, {
      // 信任页要看清是哪个目录,不做保留尾部的截断
      path: tildePath(pending.resolution.key),
      overrides: pending.resolution.overrides,
      docs: pending.docs,
    });
    const mainHeight = Math.max(1, rows - 1 - footer.length);
    const main = centerVertically(body, mainHeight).slice(0, mainHeight);
    while (main.length < mainHeight) {
      main.push('');
    }
    return [...main, separator, ...footer];
  }

  private renderCompletionMenu(width: number, height: number): string[] {
    // 命令子菜单与输入补全互斥:子菜单打开时输入框是空的,直接用它占住这块区域
    if (this.picker !== undefined) {
      const count = Math.min(COMPLETION_MENU_ROWS, Math.max(0, height - 2), this.picker.rows.length);
      return completionMenu(this.picker.rows, this.picker.index, width, this.renderContext.theme, count);
    }
    const completion = this.editor.completionState;
    if (completion === null || this.approvalCard !== undefined) {
      return [];
    }
    const count = Math.min(COMPLETION_MENU_ROWS, Math.max(0, height - 2), completion.items.length);
    const menu = completion.items.map((item) =>
      completion.kind === 'slash'
        ? { label: item, detail: CHAT_COMMAND_DESCRIPTIONS[item] }
        : splitPathLabel(item),
    );
    return completionMenu(menu, completion.index, width, this.renderContext.theme, count);
  }

  private isInputBoxRow(row: number): boolean {
    if (this.trustPrompt !== undefined || this.approvalCard !== undefined || this.viewer.isOpen) {
      return false;
    }
    const input = this.renderInputLines(this.terminal.columns);
    // 页脚 = 输入框(上下边框 + 内容行)+ 状态栏;下方行数取同一处定义,免得两处各写一个数
    const footerHeight = input.lines.length + 2 + this.footerBelowInput(this.terminal.columns).length;
    const mainHeight = Math.max(1, this.terminal.rows - footerHeight);
    const range = inputBoxRowRange(mainHeight, input.lines.length);
    return row >= range.top && row <= range.bottom;
  }

  /** 输入框下方的行:状态栏。 */
  private footerBelowInput(width: number): string[] {
    return [renderStatusBar(width, this.renderContext.theme, this.statusInfo())];
  }

  private renderFooter(width: number): { lines: string[]; cursor?: { line: number; column: number } } {
    if (this.approvalCard !== undefined) {
      const theme = this.renderContext.theme;
      const paint = theme.paint;
      const { target, decision } = this.approvalCard;
      const what = target.command ?? target.path ?? target.server ?? target.domain ?? '';
      const options = [
        paint.ok('[y] 允许'),
        paint.ok('[a] 本会话总是允许'),
        paint.fail('[n] 拒绝'),
      ];
      // 命中规则时给规则原文;靠审批模式兜底时 rule 为空,此时说的是原因而非规则
      const basis =
        decision.rule !== undefined ? `触发规则:${decision.rule}` : `原因:${decision.reason}`;
      // 「本会话总是允许」会记住什么范围,先让人看清再决定
      const scope = approvalGrant(target, decision).scope;
      const detail = scope === undefined ? basis : `${basis} · 总是允许:${scope}`;
      // 选项行与信任页同一套排布:水平居中,分隔线 + 居中选项构成同一种模态卡
      const optionsText = renderApprovalOptions(options, this.approvalIndex, theme);
      const optionsPad = Math.max(0, Math.floor((width - visibleWidth(optionsText)) / 2));
      const lines = [
        // 与信任页同一条分割线,把审批块和上方对话内容分开
        theme.paint.separator(symbols.separator.repeat(width)),
        paint.warn(`  ${symbols.warn} 需要授权`),
        `    ${theme.bold(target.tool)}: ${truncatePlain(what, Math.max(0, width - 12))}`,
        paint.muted(`    ${truncatePlain(detail, Math.max(0, width - 4))}`),
        ' '.repeat(optionsPad) + optionsText,
        // 末尾留白:选项行落在倒数第二行,与信任页选项区同高
        '',
      ];
      return { lines };
    }

    const theme = this.renderContext.theme;
    const lines: string[] = [];

    // 输入框:上下边框 + 两侧竖线;光标行列按框内偏移修正
    const input = this.renderInputLines(width);
    const frame = inputBoxFrame(width, theme, this.focused);
    lines.push(
      frame.top,
      ...input.lines.map((line) => inputBoxLine(line, width, theme, this.focused)),
      frame.bottom,
    );
    lines.push(...this.footerBelowInput(width));
    return {
      lines,
      // 失焦时不给光标:边框已经变色,光标再闪烁会让人以为还能直接输入
      cursor: this.focused
        ? { line: 1 + input.cursorLine, column: 2 + input.cursorColumn }
        : undefined,
    };
  }

  /**
   * 输入框行尾的灰色预选:子菜单命令提示它的当前值。
   *
   * 只在光标于行尾、补全菜单未打开时出现;→ 在行尾接受,继续打字自然消失。
   * /sessions 的候选随会话增长,没有「当前值」可预选,不参与。
   */
  private ghostSuggestion(): string | undefined {
    if (this.editor.completionState !== null || !this.editor.cursorAtEnd) {
      return undefined;
    }
    const text = this.editor.text;
    if (text === '/effort') {
      const effort = this.currentConfig?.reasoningEffort;
      return effort !== undefined ? ` ${effort}` : undefined;
    }
    if (text === '/model') {
      const provider = this.currentConfig?.provider;
      const model = this.currentConfig?.model;
      return provider !== undefined && model !== undefined ? ` ${provider}/${model}` : undefined;
    }
    return undefined;
  }

  /**
   * 子菜单打开时的输入框:命令 + 灰色预选值,随选中项移动而变化。
   *
   * 菜单是模态的,编辑器实际为空;这行是合成显示,让「我在回答哪个命令、
   * 回车会应用什么」始终可见。
   */
  private renderPickerInputLine(width: number): {
    lines: string[];
    cursorLine: number;
    cursorColumn: number;
  } {
    const picker = this.picker;
    const paint = this.renderContext.theme.paint;
    const command = picker !== undefined ? `/${picker.kind}` : '';
    const selected = picker?.payloads[picker.index] ?? '';
    const available = Math.max(4, width - 8);
    const ghostRoom = Math.max(0, available - visibleWidth(command));
    const ghost = paint.muted(truncatePlain(` ${selected}`, ghostRoom));
    return {
      lines: [`${paint.accent(symbols.inputPrompt)}${paintSlashCommand(command, paint.accent)}${ghost}`],
      cursorLine: 0,
      cursorColumn: visibleWidth(symbols.inputPrompt) + visibleWidth(command),
    };
  }

  private renderInputLines(width: number): {
    lines: string[];
    cursorLine: number;
    cursorColumn: number;
  } {
    if (this.picker !== undefined) {
      return this.renderPickerInputLine(width);
    }
    const text = this.editor.text;
    const { line: cursorLineRaw, column: cursorColumnRaw } = this.editor.cursorLineColumn();
    // 框内内容区 = 宽度 - 4(两侧竖线与留白),再扣除提示符与续行缩进
    const available = Math.max(4, width - 8);
    // 同步折行宽度,↑↓ 据此按视觉行移动
    this.editor.setWrapWidth(available);

    // 软折行:每个逻辑行按显示宽度切成若干视觉行,超长文本不再横向滚动
    interface VisualRow {
      logical: number;
      text: string;
      start: number;
      end: number;
    }
    const rows: VisualRow[] = [];
    text.split('\n').forEach((raw, logical) => {
      for (const row of softWrapRows(raw, available)) {
        rows.push({
          logical,
          text: row.text,
          start: row.start,
          end: row.start + [...row.text].length,
        });
      }
    });

    // 光标所在视觉行:列落在 [start, end] 内。行边界归属前一行,这样按 ↑ 从下一
    // 视觉行回到上一行行尾时,光标显示在行尾而不是下一行行首;行尾为末行则在本行
    let cursorRow = rows.findIndex(
      (row) => row.logical === cursorLineRaw && visualRowContains(row, cursorColumnRaw),
    );
    if (cursorRow < 0) {
      cursorRow = rows.reduce((last, row, index) => (row.logical === cursorLineRaw ? index : last), 0);
    }

    // 视口只显示 MAX_INPUT_LINES 行,滚动跟随光标
    let windowStart = 0;
    if (rows.length > MAX_INPUT_LINES) {
      windowStart = Math.min(
        Math.max(0, cursorRow - (MAX_INPUT_LINES - 1)),
        rows.length - MAX_INPUT_LINES,
      );
    }

    const paint = this.renderContext.theme.paint;
    // 灰色预选只标在最后一个视觉行,并截断到剩余宽度,溢出会撑破输入框
    const ghost = this.ghostSuggestion();
    const lines: string[] = [];
    let cursorLine = 0;
    let cursorColumn = 0;
    for (let index = 0; index < MAX_INPUT_LINES; index += 1) {
      const rowIndex = windowStart + index;
      const row = rows[rowIndex];
      if (row === undefined) {
        break;
      }
      const prefix = rowIndex === 0 ? paint.accent(symbols.inputPrompt) : '  ';
      let body = rowIndex === 0 ? paintSlashCommand(row.text, paint.accent) : row.text;
      if (ghost !== undefined && rowIndex === rows.length - 1) {
        const room = Math.max(0, available - visibleWidth(row.text));
        body += paint.muted(truncatePlain(ghost, room));
      }
      lines.push(`${prefix}${body}`);
      if (rowIndex === cursorRow) {
        cursorLine = index;
        let beforeWidth = 0;
        for (const char of [...row.text].slice(0, cursorColumnRaw - row.start)) {
          beforeWidth += codePointWidth(char.codePointAt(0) ?? 0);
        }
        cursorColumn = visibleWidth(symbols.inputPrompt) + beforeWidth;
      }
    }
    return { lines, cursorLine, cursorColumn };
  }

  /** 状态栏数据:配置与用量都还没有时留空,由渲染端退化成占位符。 */
  private statusInfo(): StatusBarInfo {
    const config = this.currentConfig;
    const usage = this.lastUsage;
    return {
      project: basename(this.options.workspace) || this.options.workspace,
      branch: this.branch,
      model: config?.model ?? this.runtime?.model.id,
      reasoning: config?.reasoningEffort,
      // 真实请求至少含系统提示词,输入不可能为 0:没有回传过真实用量
      // (还没跑过,或端点没回传)一律显示未知,而不是猜一个 0
      promptTokens: usage !== undefined && usage.inputTokens > 0 ? promptTokens(usage) : undefined,
      contextWindow: this.runtime?.model.contextWindow ?? config?.contextWindow,
      cacheReadTokens: usage?.cacheReadTokens,
    };
  }

  /** 分支名会被外部 git 操作改掉,按 TTL 重读一次;读不到就当不是仓库。 */
  private refreshBranch(): void {
    if (this.branchInFlight || Date.now() - this.branchCheckedAt < BRANCH_TTL_MS) {
      return;
    }
    this.branchInFlight = true;
    void readGitBranch(this.options.workspace)
      .then((branch) => {
        if (branch !== this.branch) {
          this.branch = branch;
          this.scheduleRender();
        }
      })
      .finally(() => {
        this.branchInFlight = false;
        this.branchCheckedAt = Date.now();
      });
  }

  // —— 基础工具 ——

  /** 按配置组装主题并重建渲染器(缓存随主题整体失效)。 */
  private applyTheme(): void {
    const ui = this.currentConfig?.ui;
    this.renderContext.theme = createTheme({ preset: ui?.theme });
    this.renderer = createBlockRenderer(this.renderContext);
  }

  private push(block: ScrollBlock): void {
    this.blocks.push(block);
    this.scheduleRender();
  }

  private pushNotice(text: string, level: NoticeLevel): void {
    // 通知里可能嵌着模型/工具输出,渲染前统一净化
    this.push({ kind: 'notice', text: sanitizeTerminalText(text), level });
    if (noticeDismissesWelcome(level)) {
      this.hideWelcome();
    }
  }

  /** 运行结束(含中断)后的收尾:停掉流式光标,未完成的工具标记为已中断。 */
  private markRunStopped(aborted: boolean): void {
    // 多轮运行会产出多个助手块,只收尾最后一块会让早先的块永久显示流式光标
    for (const block of this.blocks) {
      if (block.kind === 'assistant') {
        block.streaming = false;
      }
    }
    if (aborted) {
      for (const block of this.blocks) {
        if (block.kind === 'tool' && block.state === 'running') {
          block.state = 'fail';
          block.detail = '已中断';
          this.toolStartTimes.delete(block);
        }
      }
    }
  }

  private requestExit(): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    this.closed?.();
  }
}

/** 路径在用户目录下缩成 ~/xxx,分隔符统一为 /(与 displayPath 一致)。 */
function tildePath(path: string): string {
  const home = homedir().split(sep).join('/');
  const normalized = path.split(sep).join('/');
  return normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : normalized;
}

