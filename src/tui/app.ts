import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { createAgentRuntime, type AgentRuntime } from '../agent/run.ts';
import { findModelTarget, loadCatalogFile } from '../catalog/load.ts';
import type { Catalog } from '../catalog/schema.ts';
import {
  CHAT_COMMANDS,
  CHAT_COMMAND_DESCRIPTIONS,
  CHAT_HELP_TEXT,
  CHAT_KEY_HELP,
  parseChatCommand,
} from '../cli/commands/chat-commands.ts';
import { latestSessionFile, listSessionSummaries, resolveSessionFile } from '../cli/commands/sessions.ts';
import { ignoredNotice } from '../cli/trust.ts';
import { ensureHomeConfig } from '../config/ensure.ts';
import { loadLayeredConfig } from '../config/layers.ts';
import { APPROVAL_MODES, resolveReasoningEffort, REASONING_EFFORTS, type ApprovalMode, type Config, type ReasoningEffort } from '../config/schema.ts';
import { recordTrust, resolveProjectTrust, type TrustResolution } from '../config/trust.ts';
import { existingProjectDocs } from '../context/agents-md.ts';
import type { ToolCall, Usage } from '../llm/types.ts';
import { promptTokens } from '../llm/usage.ts';
import { approvalGrant, type ApprovalAnswer, type Approver } from '../permissions/approval.ts';
import type { Decision } from '../permissions/engine.ts';
import type { RuleTarget } from '../permissions/rules.ts';
import { deleteSession as deleteSessionFile, renameSession } from '../session/store.ts';
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
  renderHelpPage,
  renderTrustPage,
  renderWindow,
  scrollWindow,
  summarizeToolArgs,
  type NoticeLevel,
  type RenderContext,
  type ScrollBlock,
} from './blocks.ts';
import {
  candidateRemainder,
  centerVertically,
  COMPLETION_MENU_ROWS,
  completionMenu,
  inputBoxFrame,
  inputBoxLine,
  inputBoxRowRange,
  matchesArgument,
  menuInsertion,
  moveApprovalIndex,
  moveMenuIndex,
  overlayLines,
  paintPreviewLine,
  paintSlashCommand,
  renderApprovalOptions,
  renderScrollbarLine,
  scrollbarGeometry,
  splitPathLabel,
  tokenAt,
  tokenKind,
  type CursorToken,
  type MenuRow,
} from './chrome.ts';
import { createFileIndex, needsFileScan, type FileIndex } from './files.ts';
import { rankFileCandidates } from './files.ts';
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

/** 二级菜单的种类;候选来源与提交动作都按它分派。 */
type SubmenuKind = 'model' | 'effort' | 'sessions';

/**
 * 菜单候选的来源:斜杠命令名、子菜单参数、@ 文件引用。
 *
 * 三个来源共用同一份菜单状态、同一套按键与同一个渲染器,只有「候选怎么算」和
 * 「接受后做什么」不同——规则只有一份,不再各长一套。
 */
type MenuSource = 'command' | 'argument' | 'file';

/** 一条候选:写进输入框的值 + 菜单里两列的显示文本。 */
interface MenuItem {
  /** 接受时写进输入框的值(命令名带 /,@ 引用不带 @)。 */
  payload: string;
  label: string;
  detail?: string;
  /** 目录项:接受后不带尾空格,菜单继续列出其下内容。 */
  directory?: boolean;
  /** 当前生效项(模型 / 思考强度 / 当前会话):参数菜单默认高亮它。 */
  current?: boolean;
  /** 供检索的附加文本:有值时该候选按子串匹配(会话列表用),否则按前缀补全。 */
  search?: string;
  /** 候选项对应的会话文件;重命名与删除要按它落盘。 */
  file?: string;
}

/** 菜单状态;三个来源共用。 */
interface MenuState {
  source: MenuSource;
  /** 参数菜单的命令种类。 */
  kind?: SubmenuKind;
  /** 已按输入过滤后的候选。 */
  items: MenuItem[];
  index: number;
}

/** 菜单顶栏的按键提示:三个来源的语义不同,提示也跟着变。 */
const MENU_HINTS: Readonly<Record<MenuSource, string>> = {
  command: 'Tab/↵ 补全 · Esc 取消',
  argument: 'Tab 补全 · ↵ 执行 · Esc 取消',
  file: 'Tab/↵ 引用 · Esc 取消',
};

/** 会话菜单的提示:除了补全与恢复,还挂着三个管理动作。 */
const SESSION_MENU_HINT = 'Tab 补全 · ↵ 恢复 · Ctrl+R 排序 · Ctrl+N 重命名 · Ctrl+D 删除 · Esc 取消';

/** 重命名会话的输入行前缀,光标列要按它算。 */
const TITLE_LABEL = '标题: ';

/** 会话标题长度上限:再长在菜单里也显示不下,只会把列表挤乱。 */
const MAX_SESSION_TITLE = 60;

/** 思考强度的中文说明,参数菜单的第二列。 */
const EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极致',
};

/** 审批模式切换时的回执说明:切到哪一档、那一档意味着什么,一句话说清。 */
const APPROVAL_NOTES: Readonly<Record<ApprovalMode, string>> = {
  ask: '(需要授权时逐条询问)',
  auto: '(交由审查模型裁决;未配置 review_model 时保守拒绝)',
  yolo: '(全部自动放行,不再询问)',
};

/** 审批卡里最多摊几行改动;再多只给总行数,避免把对话区挤没。 */
const APPROVAL_PREVIEW_LINES = 10;

/** 拒绝理由那一行的前缀,光标列要按它算。 */
const REASON_LABEL = '拒绝理由: ';

/** 审批选项下标:与审批卡的选项顺序一一对应。 */
const APPROVAL_DENY_INDEX = 2;
const APPROVAL_REASON_INDEX = 3;

/** @ 文件候选上限:菜单会开窗显示,取够用即可。 */
const FILE_CANDIDATE_LIMIT = 20;

/** 带二级菜单的命令,顺序即匹配顺序。 */
const SUBMENU_KINDS: readonly SubmenuKind[] = ['model', 'effort', 'sessions'];

/** 命令名 → 菜单种类。 */
const SUBMENU_BY_COMMAND = new Map<string, SubmenuKind>(
  SUBMENU_KINDS.map((kind) => [`/${kind}`, kind]),
);
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
  /** Shift+Tab 的审批模式覆盖;undefined = 跟随配置文件。同样要跨重建留存。 */
  private approvalOverride: ApprovalMode | undefined;
  /** 快捷键页是否开着;只读整屏,任何键收起。 */
  private helpOpen = false;

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

  private approvalCard:
    | { target: RuleTarget; decision: Decision; preview?: readonly string[] }
    | undefined;
  private approvalIndex = 0;
  private approvalResolve: ((answer: ApprovalAnswer) => void) | undefined;
  /** 拒绝理由的编辑内容;undefined = 停在选项上。 */
  private approvalReason: string | undefined;
  /** 候选菜单(命令名 / 子菜单参数 / @ 文件):模态,↑↓ 移动高亮,Tab 补全,↵ 执行。 */
  private menu: MenuState | undefined;
  /** 参数菜单的全部候选;会话列表要读盘,取到后缓存,免得每次按键都扫一遍。 */
  private submenuItems: { kind: SubmenuKind; items: MenuItem[] } | undefined;
  /** 会话列表的排序方向:默认最新的在最前。 */
  private sessionSort: 'newest' | 'oldest' = 'newest';
  /** 已按过一次删除、等第二次确认的会话 id;动别的键即放弃。 */
  private sessionPendingDelete: string | undefined;
  /** 正在重命名的会话;有值时页脚换成一行输入框。 */
  private renamePrompt: { file: string; sessionId: string; text: string } | undefined;
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
    this.editor = new InputEditor();
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

  /** 上游重试:退避等待时说清「第几次、等多久」,免得看着像卡住。 */
  onRetry(info: { attempt: number; attempts: number; delayMs: number }): void {
    this.pushNotice(
      `上游请求失败,${Math.round(info.delayMs / 1000)} 秒后重试(${info.attempt}/${info.attempts - 1})`,
      'warn',
    );
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
      // 点在滚动条那一列:按点在轨道上的比例跳转,与滑块位置用同一套映射
      if (key.x >= this.terminal.columns && this.lastMaxTop > 0) {
        const travel = Math.max(1, this.lastMainHeight - 1);
        const ratio = Math.min(1, Math.max(0, (key.y - 1) / travel));
        this.follow = ratio >= 1;
        this.scrollTop = Math.round(ratio * this.lastMaxTop);
        this.scheduleRender();
        return;
      }
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
    // 重命名也是一行输入:它开着的时候输入框不显示,按键只认它
    if (this.renamePrompt !== undefined) {
      this.handleRenameKey(key);
      return;
    }
    // 快捷键页是只读的:任何键都把它收起,不落到别处
    if (this.helpOpen) {
      this.helpOpen = false;
      this.scheduleRender();
      return;
    }
    // 候选菜单也是模态的:拦截所有按键,不让它们落进输入框
    if (this.menu !== undefined) {
      this.handleMenuKey(key);
      return;
    }
    if (this.viewer.isOpen) {
      this.handleViewerKey(key);
      this.scheduleRender();
      return;
    }
    // 输入类按键重新聚焦输入框(见 INPUT_BOX_KEYS 的说明)
    this.feedEditorKey(key);
  }

  /** 编辑区按键:处理完重算菜单——输入变了,候选与预选都得跟着变。 */
  private feedEditorKey(key: TuiKey): void {
    this.applyEditorKey(key);
    this.refreshMenu();
    this.scheduleRender();
  }

  /** 编辑区按键的原始处理:聚焦、粘贴、打字、光标移动与快捷键;菜单打开时复用其中的编辑部分。 */
  private applyEditorKey(key: TuiKey): void {
    if (INPUT_BOX_KEYS.has(key.type)) {
      this.focused = true;
    }
    if (key.type === 'paste') {
      this.handlePaste(key.text);
      return;
    }
    if (key.type === 'wheel') {
      this.scrollBy(key.delta);
      return;
    }
    if (key.type === 'text') {
      // 输入框为空时的 ? 是「看快捷键」,不是打字:打问号要在已有内容后面打
      if (key.text === '?' && this.editor.isEmpty) {
        this.helpOpen = true;
        return;
      }
      this.editor.insert(key.text);
      this.maybeRefreshFileIndex();
      return;
    }
    switch (key.type) {
      case 'shift-tab':
        // 会话内循环审批模式:切到哪一档决定后面还问不问你,每次都给回执
        this.cycleApprovalMode();
        break;
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
        // 菜单由 handleMenuKey 收;这里处理无菜单时的中断 / 清空
        if (this.running) {
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
    if (!needsFileScan(this.mentionQuery(), this.fileIndex.stale())) {
      return;
    }
    void this.fileIndex
      .refresh()
      .then(() => {
        // 快照换了,候选跟着换:重算菜单,预选也就指向新的候选
        this.refreshMenu();
        this.scheduleRender();
      })
      .catch(() => undefined);
  }

  /** 光标处 @ 词条的查询文本(不含 @);不在 @ 词条内时返回 null。 */
  private mentionQuery(): string | null {
    const token = tokenAt(this.editor.text, this.editor.cursor);
    if (token === undefined || tokenKind(token, this.editor.text) !== 'mention') {
      return null;
    }
    return token.text.slice(1);
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

  // —— 候选菜单 ——
  //
  // 三个来源(命令名 / 子菜单参数 / @ 文件引用)共用这一份状态、这一套按键与同一个渲染器:
  //   ↑↓ 移动高亮(不写输入框)· Tab 把候选补进输入框 · Esc 收起菜单但保留输入 ·
  //   ↵ 命令名与 @ 只补不执行,参数菜单直接执行(整条命令就是「命令 + 参数」,选中即确认)。
  // 灰色预选 = 按 Tab 会补进来的那段文本:菜单里看到什么,按下 Tab 就得到什么。

  /** 菜单按键。 */
  private handleMenuKey(key: TuiKey): void {
    const menu = this.menu;
    if (menu === undefined) {
      return;
    }
    // 会话菜单多三个管理动作:排序 / 重命名 / 删除
    if (menu.kind === 'sessions') {
      if (key.type === 'ctrl-d') {
        this.requestSessionDelete(menu);
        return;
      }
      if (key.type === 'ctrl-r') {
        this.clearSessionPendingDelete();
        this.toggleSessionSort();
        return;
      }
      if (key.type === 'ctrl-n') {
        this.clearSessionPendingDelete();
        this.beginSessionRename(menu);
        return;
      }
    }
    // 待确认的删除只认紧邻的下一次 ^D:中间动了别的键就撤销,免得手滑删掉会话
    this.clearSessionPendingDelete();
    const moved = moveMenuIndex(key, menu.index, menu.items.length);
    if (moved !== undefined) {
      if (moved !== menu.index) {
        menu.index = moved;
        this.scheduleRender();
      }
      return;
    }
    if (key.type === 'tab') {
      this.acceptMenuCandidate();
      return;
    }
    if (key.type === 'right') {
      // → 在行尾先接受灰色预选(同 shell 自动建议的肌肉记忆),没有预选才移动光标
      if (!this.editor.cursorAtEnd || !this.acceptMenuCandidate()) {
        this.applyEditorKey(key);
        this.refreshMenu();
        this.scheduleRender();
      }
      return;
    }
    if (key.type === 'enter') {
      const payload = menu.items[menu.index]?.payload;
      if (payload === undefined) {
        return;
      }
      if (menu.source === 'argument') {
        void this.runSubmenuCommand(menu, payload);
        return;
      }
      this.acceptMenuCandidate();
      return;
    }
    if (key.type === 'escape') {
      // 收起菜单但保留输入:再按一次才是清空(与无菜单时的 Esc 阶梯接上)
      this.closeMenu();
      this.scheduleRender();
      return;
    }
    // 菜单是模态编辑态,视图切换键不放行:叠加查看器会让按键路由错乱
    if (key.type === 'ctrl-o' || key.type === 'ctrl-e') {
      this.scheduleRender();
      return;
    }
    // 其余按键交给编辑器:输入框始终可编辑,菜单只是候选视图
    this.applyEditorKey(key);
    this.refreshMenu();
    this.scheduleRender();
  }

  /**
   * 把高亮候选补进输入框(替换光标处的词条),不执行。
   *
   * 返回 false 表示没有候选、或候选与已输入内容不相容——那种情况下补全不是「接着打」
   * 而是替换,拿无关候选顶替用户打的字(比如 /sessions 里换成别的会话)还不如不动。
   */
  private acceptMenuCandidate(): boolean {
    const menu = this.menu;
    const target = this.completionTarget();
    const item = menu?.items[menu.index];
    if (menu === undefined || target === undefined || item === undefined) {
      return false;
    }
    if (!item.payload.startsWith(target.typed)) {
      return false;
    }
    this.editor.replaceRange(target.token.start, target.token.end, this.menuReplacement(item, menu.source));
    this.refreshMenu();
    this.scheduleRender();
    return true;
  }

  /** 执行参数菜单选中的候选:关菜单、清输入框,再按种类落到对应命令上。 */
  private async runSubmenuCommand(menu: MenuState, payload: string): Promise<void> {
    const kind = menu.kind;
    this.closeMenu();
    this.editor.clear();
    this.scheduleRender();
    if (kind === undefined) {
      return;
    }
    if (kind === 'model') {
      await this.commandModel(payload);
    } else if (kind === 'effort') {
      this.commandEffort(payload);
    } else {
      await this.commandResume(payload);
    }
  }

  /** 会话列表排序:最新在前 ⇄ 最旧在前。候选顺序变了,缓存作废后重摆菜单。 */
  private toggleSessionSort(): void {
    this.sessionSort = this.sessionSort === 'newest' ? 'oldest' : 'newest';
    this.submenuItems = undefined;
    const typed = this.completionTarget()?.typed ?? '';
    void this.showArgumentMenu('sessions', typed);
  }

  /** 待确认的删除只认紧邻的下一次 ^D;这里在别的按键到来时撤销它。 */
  private clearSessionPendingDelete(): void {
    if (this.sessionPendingDelete !== undefined) {
      this.sessionPendingDelete = undefined;
      this.scheduleRender();
    }
  }

  /** 删除会话:第一次 ^D 只是举手(提示改成「再按一次」),再按一次才真删。 */
  private requestSessionDelete(menu: MenuState): void {
    const item = menu.items[menu.index];
    if (item === undefined) {
      return;
    }
    if (this.sessionPendingDelete !== item.payload) {
      this.sessionPendingDelete = item.payload;
      this.scheduleRender();
      return;
    }
    this.sessionPendingDelete = undefined;
    void this.deleteSession(item);
  }

  private async deleteSession(item: MenuItem): Promise<void> {
    const file = item.file;
    if (file === undefined) {
      return;
    }
    if (item.current === true) {
      // 正在用的会话随时会被追加:删掉文件,下一次写入又把它建回来
      this.pushNotice('当前会话不能删除,先 /new 开一个新会话再删它。', 'warn');
      return;
    }
    try {
      await deleteSessionFile(file);
      this.submenuItems = undefined;
      this.pushNotice(`已删除会话:${item.label}`, 'info');
      this.refreshMenu();
      this.scheduleRender();
    } catch (error) {
      this.pushNotice(`错误:${describeError(error)}`, 'error');
    }
  }

  /** 开始重命名:收起菜单,页脚换成一行输入框,预填现有标题。 */
  private beginSessionRename(menu: MenuState): void {
    const item = menu.items[menu.index];
    if (item === undefined || item.file === undefined) {
      return;
    }
    this.closeMenu();
    this.renamePrompt = {
      file: item.file,
      sessionId: item.payload,
      // 没起过名的会话在列表里显示的是 id,此时输入框留空而不是预填 id
      text: item.label === item.payload ? '' : item.label,
    };
    this.scheduleRender();
  }

  /** 重命名输入:只认文本与退格;回车保存,Esc 放弃并退回列表。 */
  private handleRenameKey(key: TuiKey): void {
    const prompt = this.renamePrompt;
    if (prompt === undefined) {
      return;
    }
    // 这一行是当前唯一的输入位:不管刚才点过哪里,按键进来就重新聚焦
    this.focused = true;
    if (key.type === 'text') {
      const typed = [...key.text].filter((char) => (char.codePointAt(0) ?? 0) >= 32).join('');
      const room = MAX_SESSION_TITLE - [...prompt.text].length;
      this.renamePrompt = { ...prompt, text: prompt.text + typed.slice(0, Math.max(0, room)) };
      this.scheduleRender();
      return;
    }
    if (key.type === 'backspace') {
      this.renamePrompt = { ...prompt, text: [...prompt.text].slice(0, -1).join('') };
      this.scheduleRender();
      return;
    }
    if (key.type === 'enter') {
      void this.finishRename(prompt.text);
      return;
    }
    if (key.type === 'escape' || key.type === 'ctrl-c') {
      this.renamePrompt = undefined;
      this.refreshMenu();
      this.scheduleRender();
    }
  }

  /** 落盘标题:空标题即清除,列表退回显示首条消息。 */
  private async finishRename(title: string): Promise<void> {
    const prompt = this.renamePrompt;
    if (prompt === undefined) {
      return;
    }
    this.renamePrompt = undefined;
    try {
      await renameSession(prompt.file, title);
      // 缓存里还带着旧标题,必须重取
      this.submenuItems = undefined;
      const clean = title.trim();
      this.pushNotice(
        clean === ''
          ? `已清除会话标题:${prompt.sessionId}`
          : `会话 ${prompt.sessionId} 已命名为「${clean}」`,
        'info',
      );
    } catch (error) {
      this.pushNotice(`错误:${describeError(error)}`, 'error');
    }
    this.refreshMenu();
    this.scheduleRender();
  }

  /** 输入变化后重算菜单:来源由光标处的词条决定,没有候选就收起菜单。 */
  private refreshMenu(): void {
    const target = this.completionTarget();
    if (target === undefined) {
      this.closeMenu();
      return;
    }
    if (target.source === 'argument') {
      const kind = this.argumentKind();
      if (kind === undefined) {
        this.closeMenu();
        return;
      }
      // 参数菜单的候选要读盘(会话列表),拿到之前先收起旧菜单:否则高亮、预选会
      // 拿着上一份候选去配新词条,画出一段对不上的预选
      this.dropStaleMenu('argument', kind);
      void this.showArgumentMenu(kind, target.typed);
      return;
    }
    this.dropStaleMenu(target.source);
    const items =
      target.source === 'command' ? this.commandItems(target.typed) : this.fileItems(target.typed);
    this.showMenu(target.source, items);
  }

  /** 词条换了来源(或换了菜单种类)就收起旧菜单:候选与词条必须来自同一次判定。 */
  private dropStaleMenu(source: MenuSource, kind?: SubmenuKind): void {
    const menu = this.menu;
    if (menu !== undefined && (menu.source !== source || menu.kind !== kind)) {
      this.closeMenu();
    }
  }

  /** 参数菜单:候选可能要读盘(会话列表),取到后再按当前输入过滤显示。 */
  private async showArgumentMenu(kind: SubmenuKind, typed: string): Promise<void> {
    const all = await this.submenuItemsFor(kind);
    if (all === undefined) {
      this.closeMenu();
      return;
    }
    // 取候选期间用户可能改了输入:只有仍停在同一个参数菜单上才显示
    if (this.argumentKind() !== kind) {
      return;
    }
    this.showMenu('argument', all.filter((item) => matchesArgument(item, typed)), kind);
  }

  /** 摆出菜单并挑高亮:优先沿用上一次的高亮,其次当前生效项,最后首项。 */
  private showMenu(source: MenuSource, items: MenuItem[], kind?: SubmenuKind): void {
    if (items.length === 0) {
      this.closeMenu();
      return;
    }
    const previous = this.menu?.items[this.menu.index]?.payload;
    const kept = previous === undefined ? -1 : items.findIndex((item) => item.payload === previous);
    const current = items.findIndex((item) => item.current === true);
    this.menu = { source, kind, items, index: kept >= 0 ? kept : current >= 0 ? current : 0 };
    this.scheduleRender();
  }

  private closeMenu(): void {
    this.menu = undefined;
  }

  /**
   * 当前要补全的词条、来源与已输入的部分;没有可补的返回 undefined。
   *
   * 参数菜单取「命令之后」的整段——可能是空的(`/effort ` 后面还没打字),空词条也算
   * 一个位置,接受时就在那里插入候选。
   */
  private completionTarget(): { token: CursorToken; source: MenuSource; typed: string } | undefined {
    const text = this.editor.text;
    const kind = this.argumentKind();
    if (kind !== undefined) {
      const start = kind.length + 2;
      return {
        token: { start, end: text.length, text: text.slice(start) },
        source: 'argument',
        typed: text.slice(start).trim(),
      };
    }
    const token = tokenAt(text, this.editor.cursor);
    if (token === undefined) {
      return undefined;
    }
    const kindOfToken = tokenKind(token, text);
    if (kindOfToken === 'command') {
      return { token, source: 'command', typed: token.text };
    }
    if (kindOfToken === 'mention') {
      return { token, source: 'file', typed: token.text.slice(1) };
    }
    return undefined;
  }

  /** 输入框是否正停在某个参数菜单上(整行读作「/<命令> …」)。 */
  private argumentKind(): SubmenuKind | undefined {
    const text = this.editor.text;
    const cut = text.search(/\s/);
    return cut <= 0 ? undefined : SUBMENU_BY_COMMAND.get(text.slice(0, cut));
  }

  /**
   * 候选写进输入框的完整文本(词条要替换成什么)。
   *
   * 尾空格表示「后面还要接着写」:命令名后面接参数、@ 引用后面接句子,都留一个空格;
   * 目录要下钻、参数是行尾最后一个词,补完即完,不留——留了下次打字会另起一个词。
   */
  private menuReplacement(item: MenuItem, source: MenuSource): string {
    if (source === 'file') {
      return `@${menuInsertion(item.payload, item.directory === true)}`;
    }
    return source === 'argument' ? item.payload : menuInsertion(item.payload);
  }

  /** 命令名候选:前缀命中;已完整输入的那个不再出现(该去补参数了)。 */
  private commandItems(typed: string): MenuItem[] {
    return CHAT_COMMANDS.filter((command) => command.startsWith(typed) && command !== typed).map(
      (command) => ({ payload: command, label: command, detail: CHAT_COMMAND_DESCRIPTIONS[command] }),
    );
  }

  /** @ 文件候选:按路径相关度排序,目录项以 '/' 结尾。 */
  private fileItems(typed: string): MenuItem[] {
    return rankFileCandidates(this.fileIndex.list(), typed, FILE_CANDIDATE_LIMIT).map((path) => ({
      payload: path,
      directory: path.endsWith('/'),
      ...splitPathLabel(path),
    }));
  }

  /** 参数菜单的全部候选;会话列表要读盘,取到后缓存,免得每次按键都扫一遍。 */
  private async submenuItemsFor(kind: SubmenuKind): Promise<MenuItem[] | undefined> {
    const cached = this.submenuItems;
    if (cached !== undefined && cached.kind === kind) {
      return cached.items;
    }
    const items = await this.loadSubmenuItems(kind);
    if (items === undefined) {
      return undefined;
    }
    this.submenuItems = { kind, items };
    return items;
  }

  private async loadSubmenuItems(kind: SubmenuKind): Promise<MenuItem[] | undefined> {
    if (kind === 'model') {
      if (this.catalog === undefined) {
        this.pushNotice('(尚未就绪:产商目录未加载)', 'warn');
        return undefined;
      }
      const items: MenuItem[] = [];
      for (const [name, spec] of Object.entries(this.catalog.providers)) {
        for (const model of spec.models) {
          const active =
            this.currentConfig?.provider === name && this.currentConfig.model === model.id;
          items.push({
            payload: `${name}/${model.id}`,
            label: `${name}/${model.id}`,
            detail: active ? '当前使用' : undefined,
            current: active,
          });
        }
      }
      return items;
    }
    if (kind === 'effort') {
      const active = this.currentConfig?.reasoningEffort;
      return REASONING_EFFORTS.map((level) => ({
        payload: level,
        label: level,
        detail: EFFORT_LABELS[level],
        current: level === active,
      }));
    }
    const summaries = await listSessionSummaries(this.options.home, this.options.workspace);
    if (summaries.length === 0) {
      this.pushNotice('当前项目还没有会话(`reins sessions list` 可查看全部项目)。', 'info');
      return undefined;
    }
    const activeId = this.runtime?.session.id;
    const ordered = this.sessionSort === 'newest' ? summaries : [...summaries].reverse();
    return ordered.map((summary) => {
      const when = summary.createdAt.replace('T', ' ').slice(0, 19);
      return {
        payload: summary.sessionId,
        // 起过名就显示名字;此时 id 挪到第二列,否则列表里就再没有 id 可认了
        label: summary.title ?? summary.sessionId,
        detail:
          summary.title === undefined
            ? `${when}  ${summary.preview}`
            : `${when}  ${summary.sessionId}  ${summary.preview}`,
        // 检索文本:id、标题与首条消息都能命中
        search: `${summary.sessionId} ${summary.title ?? ''} ${summary.preview}`,
        file: summary.file,
        current: summary.sessionId === activeId,
      };
    });
  }

  /** 裸命令回车:补上参数位的空格,参数菜单随之摆出来。 */
  private openSubmenuFor(kind: SubmenuKind): void {
    this.editor.replaceWith(`/${kind} `);
    this.refreshMenu();
  }

  private async commandModel(target: string | undefined): Promise<void> {
    if (target === undefined) {
      this.openSubmenuFor('model');
      return;
    }
    if (this.catalog === undefined) {
      this.pushNotice('(尚未就绪:产商目录未加载)', 'warn');
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
      this.openSubmenuFor('effort');
      return;
    }
    // 手打前缀按行尾提示补全后回车(xh → xhigh);歧义或无命中仍报错
    const level = resolveReasoningEffort(value);
    if (level === undefined) {
      this.pushNotice(`未知思考强度:${value}(可选:${REASONING_EFFORTS.join('|')})`, 'warn');
      return;
    }
    this.effortOverride = level;
    if (this.currentConfig !== undefined) {
      this.currentConfig.reasoningEffort = level;
    }
    this.pushNotice(`思考强度已切换:${level}`, 'info');
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
      this.openSubmenuFor('sessions');
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
    this.currentConfig = this.applyOverrides(layered.config);
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
    this.currentConfig = this.applyOverrides({
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

  /** 装配生效配置:/effort 与审批模式的会话内覆盖要压过配置文件,且在重建后继续生效。 */
  private applyOverrides(config: Config): Config {
    return {
      ...config,
      ...(this.effortOverride !== undefined ? { reasoningEffort: this.effortOverride } : {}),
      ...(this.approvalOverride !== undefined ? { approval: this.approvalOverride } : {}),
    };
  }

  /** Shift+Tab:循环切换审批模式。每次都给回执——切到哪一档直接决定后面还问不问你。 */
  private cycleApprovalMode(): void {
    const current = this.currentConfig?.approval ?? 'ask';
    const index = APPROVAL_MODES.indexOf(current);
    const next = APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? 'ask';
    this.approvalOverride = next;
    if (this.currentConfig !== undefined) {
      this.currentConfig.approval = next;
    }
    // 运行时里的引擎与审批门各存了一份模式,一起换;不重建,免得断掉 MCP 与当前回合
    this.runtime?.setApprovalMode(next);
    this.pushNotice(`审批模式:${next}${APPROVAL_NOTES[next]}`, next === 'yolo' ? 'warn' : 'info');
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
    ask: (target, decision, preview) => this.askApproval(target, decision, preview),
  };

  private askApproval(
    target: RuleTarget,
    decision: Decision,
    preview?: readonly string[],
  ): Promise<ApprovalAnswer> {
    if (this.alwaysAllow.has(approvalGrant(target, decision).key)) {
      return Promise.resolve({ verdict: 'allow' });
    }
    // 审批需要立即关注:把查看器收起,让审批卡片可见
    this.viewer.close();
    this.approvalIndex = 0;
    this.approvalReason = undefined;
    this.approvalCard = { target, decision, preview };
    this.scheduleRender();
    return new Promise<ApprovalAnswer>((resolve) => {
      this.approvalResolve = resolve;
    });
  }

  private handleApprovalKey(key: TuiKey): void {
    if (this.approvalCard === undefined || this.approvalResolve === undefined) {
      return;
    }
    // 正在写拒绝理由:这一段只编辑文字,回车落定,Esc 退回选项
    if (this.approvalReason !== undefined) {
      this.editApprovalReason(key);
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
    if (key.type === 'text') {
      const choice = key.text.toLowerCase();
      if (choice === 'y') {
        this.finishApproval(0);
        return;
      }
      if (choice === 'a') {
        this.finishApproval(1);
        return;
      }
      if (choice === 'n') {
        this.finishApproval(APPROVAL_DENY_INDEX);
        return;
      }
      if (choice === 'r') {
        // 拒绝并说明:理由随裁决进入工具结果,模型据此改法而不是重试
        this.approvalReason = '';
        this.approvalIndex = APPROVAL_REASON_INDEX;
        this.scheduleRender();
        return;
      }
    }
    if (key.type === 'escape' || key.type === 'ctrl-c') {
      this.finishApproval(APPROVAL_DENY_INDEX);
    }
  }

  /**
   * 审批卡里的改动预览:工具给的几行 diff,超过上限就截断并说明总行数。
   *
   * 预览行数与卡片高度联动(页脚按行数撑开),所以这里只做上限约束,不压缩布局。
   */
  private approvalPreviewLines(width: number): string[] {
    const preview = this.approvalCard?.preview;
    if (preview === undefined || preview.length === 0) {
      return [];
    }
    const limit = APPROVAL_PREVIEW_LINES;
    const shown = preview.slice(0, limit);
    const lines = shown.map((line) => paintPreviewLine(line, width, this.renderContext.theme));
    if (preview.length > limit) {
      lines.push(this.renderContext.theme.paint.muted(`    … 共 ${preview.length} 行改动,已省略`));
    }
    return lines;
  }

  /** 拒绝理由的编辑:只认文本与退格;回车落定,Esc 退回选项(理由留着)。 */
  private editApprovalReason(key: TuiKey): void {
    const text = this.approvalReason;
    if (text === undefined) {
      return;
    }
    if (key.type === 'text') {
      const typed = [...key.text].filter((char) => (char.codePointAt(0) ?? 0) >= 32).join('');
      this.approvalReason = text + typed;
      this.scheduleRender();
      return;
    }
    if (key.type === 'backspace') {
      this.approvalReason = [...text].slice(0, -1).join('');
      this.scheduleRender();
      return;
    }
    if (key.type === 'enter') {
      this.finishApproval(APPROVAL_DENY_INDEX, text.trim());
      return;
    }
    if (key.type === 'escape') {
      this.approvalReason = undefined;
      this.scheduleRender();
    }
  }

  private finishApproval(index: number, reason?: string): void {
    const card = this.approvalCard;
    const resolve = this.approvalResolve;
    if (card === undefined || resolve === undefined) {
      return;
    }
    if (index === 1) {
      this.alwaysAllow.add(approvalGrant(card.target, card.decision).key);
    }
    this.approvalCard = undefined;
    this.approvalReason = undefined;
    this.approvalResolve = undefined;
    const verdict: 'allow' | 'deny' = index >= APPROVAL_DENY_INDEX ? 'deny' : 'allow';
    resolve(reason === undefined || reason === '' ? { verdict } : { verdict, reason });
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
    // 快捷键页独占整屏:任何键收起
    if (this.helpOpen) {
      this.terminal.render(this.renderHelpFrame(cols, rows), null);
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
   * 快捷键页整屏:与信任页同一套「独占整屏 + 垂直居中」的排版。
   *
   * 键位表来自 CHAT_KEY_HELP,与 /help 是同一份数据,不会两处走样。
   */
  private renderHelpFrame(cols: number, rows: number): string[] {
    const theme = this.renderContext.theme;
    const mainHeight = Math.max(1, rows - 2);
    const body = renderHelpPage(cols, theme, CHAT_KEY_HELP);
    const main = centerVertically(body, mainHeight).slice(0, mainHeight);
    while (main.length < mainHeight) {
      main.push('');
    }
    return [...main, '', theme.paint.muted(' 按任意键返回')];
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

  /** 候选菜单:三个来源共用同一个渲染器,顶栏挂按键提示。 */
  private renderCompletionMenu(width: number, height: number): string[] {
    const menu = this.menu;
    if (menu === undefined || this.approvalCard !== undefined) {
      return [];
    }
    const count = Math.min(COMPLETION_MENU_ROWS, Math.max(0, height - 2), menu.items.length);
    const rows: MenuRow[] = menu.items.map((item) => ({ label: item.label, detail: item.detail }));
    return completionMenu(
      rows,
      menu.index,
      width,
      this.renderContext.theme,
      count,
      this.menuHint(menu),
    );
  }

  /** 菜单顶栏提示:会话菜单挂管理动作;待确认删除时改成「再按一次」,把话说在动作旁边。 */
  private menuHint(menu: MenuState): string {
    if (menu.kind !== 'sessions') {
      return MENU_HINTS[menu.source];
    }
    return this.sessionPendingDelete === undefined
      ? SESSION_MENU_HINT
      : `再按一次 Ctrl+D 删除 ${this.sessionPendingDelete} · 其他键取消`;
  }

  private isInputBoxRow(row: number): boolean {
    if (
      this.trustPrompt !== undefined ||
      this.approvalCard !== undefined ||
      this.renamePrompt !== undefined ||
      this.viewer.isOpen
    ) {
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
    if (this.renamePrompt !== undefined) {
      const theme = this.renderContext.theme;
      const { sessionId, text } = this.renamePrompt;
      const lines = [
        theme.paint.separator(symbols.separator.repeat(width)),
        theme.paint.muted(truncatePlain(`  重命名会话 ${sessionId} · 留空恢复默认 · ↵ 保存 · Esc 取消`, width)),
        `  ${TITLE_LABEL}${text}`,
        '',
      ];
      return {
        lines,
        // 光标落在标题末尾,与拒绝理由那一行的算法一致
        cursor: { line: 2, column: 2 + visibleWidth(TITLE_LABEL) + visibleWidth(text) },
      };
    }
    if (this.approvalCard !== undefined) {
      const theme = this.renderContext.theme;
      const paint = theme.paint;
      const { target, decision } = this.approvalCard;
      const what = target.command ?? target.path ?? target.server ?? target.domain ?? '';
      const options = [
        paint.ok('[y] 允许'),
        paint.ok('[a] 本会话总是允许'),
        paint.fail('[n] 拒绝'),
        paint.fail('[r] 拒绝并说明'),
      ];
      // 命中规则时给规则原文;靠审批模式兜底时 rule 为空,此时说的是原因而非规则
      const basis =
        decision.rule !== undefined ? `触发规则:${decision.rule}` : `原因:${decision.reason}`;
      // 「本会话总是允许」会记住什么范围,先让人看清再决定
      const scope = approvalGrant(target, decision).scope;
      const detail = scope === undefined ? basis : `${basis} · 总是允许:${scope}`;
      // 选项缩进 2 格:› 占两格,选项文字因此与上面的工具、依据同一条左基准线
      const optionsText = renderApprovalOptions(options, this.approvalIndex, theme);
      const reason = this.approvalReason;
      const lines = [
        // 与信任页同一条分割线,把审批块和上方对话内容分开
        theme.paint.separator(symbols.separator.repeat(width)),
        paint.warn(`  ${symbols.warn} 需要授权`),
        `    ${theme.bold(target.tool)}: ${truncatePlain(what, Math.max(0, width - 12))}`,
        paint.muted(`    ${truncatePlain(detail, Math.max(0, width - 4))}`),
        ...this.approvalPreviewLines(width),
        reason === undefined ? `  ${optionsText}` : `  拒绝理由: ${reason}`,
        // 末尾留白:选项行落在倒数第二行,与信任页选项区同高
        '',
      ];
      // 写理由时把光标放到理由末尾,让人知道字往哪里落;选项行永远是倒数第二行
      const optionsRow = lines.length - 2;
      return reason === undefined
        ? { lines }
        : {
            lines,
            // 缩进 2 格 + 标签宽度,再往后才是理由正文
            cursor: { line: optionsRow, column: 2 + visibleWidth(REASON_LABEL) + visibleWidth(reason) },
          };
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
   * 灰色预选:高亮候选接在已输入内容之后的那一段,也就是按 Tab 会补进来的文本。
   *
   * 只在光标于行尾时显示与接受(光标在句中时预选会挤到别的文字中间)。预选不进输入框:
   * 回车执行它,打字直接把它换掉,Tab/→ 才把它落进去。
   */
  private ghostSuggestion(): string | undefined {
    if (!this.editor.cursorAtEnd) {
      return undefined;
    }
    const target = this.completionTarget();
    const item = this.menu?.items[this.menu.index];
    if (target === undefined || item === undefined) {
      return undefined;
    }
    return candidateRemainder(this.menuReplacement(item, target.source), target.token.text);
  }

  private renderInputLines(width: number): {
    lines: string[];
    cursorLine: number;
    cursorColumn: number;
  } {
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
      // 参数按普通输入文本着色:子菜单预填的候选也在输入框里、回车就会执行,
      // 涂灰会与「还没落进输入框的行尾预选」混为一谈,让人以为补全没生效
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
      // 默认的 ask 不占位;切到 auto/yolo 就常显,提醒安全边界已经放宽
      approval: config?.approval !== undefined && config.approval !== 'ask' ? config.approval : undefined,
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

