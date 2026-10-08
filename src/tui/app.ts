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
import type { Config } from '../config/schema.ts';
import { recordTrust, resolveProjectTrust, type TrustResolution } from '../config/trust.ts';
import { existingProjectDocs } from '../context/agents-md.ts';
import type { ToolCall } from '../llm/types.ts';
import type { Approver } from '../permissions/approval.ts';
import type { Decision } from '../permissions/engine.ts';
import type { RuleTarget } from '../permissions/rules.ts';
import type { AgentUi } from '../ui/printer.ts';
import { describeError } from '../util/errors.ts';
import { absolutize, reinsHome } from '../util/paths.ts';
import type { CommandIo, ParsedArgs } from '../cli/args.ts';
import {
  createBlockRenderer,
  formatElapsed,
  renderTrustMenu,
  renderTrustPage,
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
  overlayLines,
  renderScrollbarLine,
  scrollbarGeometry,
  splitPathLabel,
} from './chrome.ts';
import { createFileIndex, needsFileScan, type FileIndex } from './files.ts';
import { InputEditor } from './editor.ts';
import { createKeyDecoder, type TuiKey } from './keys.ts';
import { codePointWidth, padAnsi, softWrapRows, truncatePlain, visibleWidth, visualRowContains } from './layout.ts';
import { Terminal } from './screen.ts';
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
/** 状态条消息的驻留时长。 */
const STATUS_MS = 3000;

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
          ? await latestSessionFile(home)
          : await resolveSessionFile(home, String(flag));
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

  private running = false;
  private runController: AbortController | undefined;
  private runStartedAt = 0;
  private spinnerIndex = 0;

  private scrollTop = 0;
  private follow = true;
  private lastMainHeight = 1;
  private lastMaxTop = 0;

  private approvalCard: { target: RuleTarget; decision: Decision } | undefined;
  private approvalResolve: ((verdict: 'allow' | 'deny') => void) | undefined;
  /** 目录信任判定结果;启动时先于会话确定。 */
  private trust: TrustResolution | undefined;
  /** 待回答的信任页;有值时整屏只显示它。docs 是会被注入的说明文件。 */
  private trustPrompt:
    | { resolution: TrustResolution; docs: string[]; resolve: (accepted: boolean) => void }
    | undefined;

  private statusMessage: { text: string; until: number } | undefined;
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

    // 信任先于会话:未信任就不加载项目层配置、不注入项目说明文件
    if (!(await this.resolveTrust())) {
      this.cleanupTerminal();
      return 1;
    }

    this.push({ kind: 'welcome' });
    // 预热文件索引:首次按 @ 就能直接出候选,不必等后台扫描完
    void this.fileIndex.refresh();
    try {
      await this.startup();
    } catch (error) {
      this.pushNotice(`配置未就绪:${describeError(error)}(修复后可输入任务重试)`, 'warn');
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

    await new Promise<void>((resolve) => {
      this.closed = resolve;
    });

    this.cleanupTerminal();
    await this.runtime?.close().catch(() => undefined);
    return 0;
  }

  /** 退出清理:先停定时器,再恢复终端。 */
  private cleanupTerminal(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
    }
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
    }
    if (this.escFlushTimer !== undefined) {
      clearTimeout(this.escFlushTimer);
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
      this.trustPrompt = { resolution, docs, resolve };
      this.scheduleRender();
    });
  }

  /** 信任页按键:y 信任并继续,n / Esc 退出。 */
  private handleTrustKey(key: TuiKey): void {
    const pending = this.trustPrompt;
    if (pending === undefined) {
      return;
    }
    const accepted = key.type === 'text' && key.text.trim().toLowerCase().startsWith('y');
    const declined = key.type === 'escape' || key.type === 'ctrl-c';
    const rejected = key.type === 'text' && key.text.trim().toLowerCase().startsWith('n');
    if (!accepted && !declined && !rejected) {
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

  /** 输入框一旦有内容就撤掉欢迎面板;单向,清空输入也不找回来。 */
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
    const last = this.blocks[this.blocks.length - 1];
    if (last !== undefined && last.kind === 'assistant' && last.streaming) {
      last.text += text;
    } else {
      this.blocks.push({ kind: 'assistant', text, streaming: true });
    }
    this.scheduleRender();
  }

  onToolCall(call: ToolCall): void {
    const block: ScrollBlock = {
      kind: 'tool',
      name: call.name,
      summary: summarizeToolArgs(call.arguments),
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
    block.state = isError ? 'fail' : 'ok';
    block.elapsedMs = started !== undefined ? Date.now() - started : undefined;
    block.output = content;
    if (isError) {
      block.detail = (content.split('\n')[0] ?? '').trim();
    }
    this.toolStartTimes.delete(block);
    this.scheduleRender();
  }

  onNotice(message: string): void {
    this.pushNotice(message, 'info');
  }

  // —— 按键分发 ——

  private handleKey(key: TuiKey): void {
    if (this.exiting) {
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
    if (this.viewer.isOpen) {
      this.handleViewerKey(key);
      this.scheduleRender();
      return;
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
        void this.submit();
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
      this.flashStatus(`已粘贴 ${lines} 行 · 回车发送`);
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
    void this.fileIndex.refresh().then(() => {
      this.editor.refreshCompletion();
      this.scheduleRender();
    });
  }

  private toggleToolExpand(): void {
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      const block = this.blocks[index];
      if (block !== undefined && block.kind === 'tool') {
        block.expanded = !(block.expanded === true);
        return;
      }
    }
    this.flashStatus('没有可展开的工具输出');
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
      this.flashStatus('还没有可查看的内容');
      return;
    }
    this.viewer.open(target);
  }

  private flashStatus(text: string): void {
    this.statusMessage = { text, until: Date.now() + STATUS_MS };
    // 状态条到点后自动隐去
    setTimeout(() => this.scheduleRender(), STATUS_MS + 50);
    this.scheduleRender();
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
    if (this.editor.completionState !== null) {
      this.editor.applyCompletion();
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
      case 'session':
        this.pushNotice(
          this.runtime !== undefined ? `会话文件:${this.runtime.session.path}` : '(暂无会话)',
          'info',
        );
        break;
      case 'status':
        this.printStatus();
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
      case 'resume':
        await this.commandResume(command.id);
        break;
      case 'prompt':
        await this.runPrompt(command.text);
        break;
    }
  }

  private printStatus(): void {
    if (this.runtime === undefined || this.currentConfig === undefined) {
      this.pushNotice('(尚未就绪:配置未加载)', 'warn');
      return;
    }
    const entries = this.runtime.session.activeBranch().length;
    const mcp =
      this.runtime.mcp.length === 0
        ? '未配置'
        : this.runtime.mcp
            .map((status) => `${status.name}(${status.ok ? `${status.toolCount ?? 0} 工具` : '未连接'})`)
            .join('、');
    this.pushNotice(
      [
        `会话   ${this.runtime.session.id} · ${entries} 条记录`,
        `模型   ${this.currentConfig.provider}/${this.currentConfig.model}`,
        `工作区 ${this.options.workspace}`,
        `审批   ${this.currentConfig.approval} · 沙箱 ${this.currentConfig.sandbox}`,
        `信任   ${this.trustText()}`,
        `MCP    ${mcp}`,
        `文件   ${this.runtime.session.path}`,
      ].join('\n'),
      'info',
    );
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

  private async commandNew(): Promise<void> {
    try {
      await this.rebuild({ freshSession: true });
      this.pushNotice(`已开始新会话:${this.runtime?.session.id ?? ''}`, 'info');
    } catch (error) {
      this.pushNotice(`错误:${describeError(error)}`, 'error');
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
      for (const [name, spec] of Object.entries(this.catalog.providers)) {
        for (const model of spec.models) {
          const current =
            this.currentConfig?.provider === name && this.currentConfig.model === model.id;
          this.pushNotice(`${current ? '› ' : '  '}${name}/${model.id}`, 'info');
        }
      }
      this.pushNotice('用法:/model <provider/model-id>', 'info');
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

  private async commandResume(id: string | undefined): Promise<void> {
    if (id === undefined) {
      const summaries = await listSessionSummaries(this.options.home);
      if (summaries.length === 0) {
        this.pushNotice('还没有任何会话。', 'info');
      }
      for (const summary of summaries.slice(0, 10)) {
        this.pushNotice(
          `${summary.sessionId}  ${summary.createdAt.replace('T', ' ').slice(0, 19)}  ${summary.preview}`,
          'info',
        );
      }
      this.pushNotice('用法:/resume <会话 id>(或 reins resume 恢复最近一次)', 'info');
      return;
    }
    try {
      await this.rebuild({ sessionFile: await resolveSessionFile(this.options.home, id) });
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
    this.runStartedAt = Date.now();
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
    this.currentConfig = layered.config;
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

  /** 信任状态一行文案,供 /status 展示。 */
  private trustText(): string {
    const trust = this.trust;
    if (trust === undefined) {
      return '未解析';
    }
    if (!trust.projectAllowed) {
      return `未信任该目录,只加载全局配置(授权:把 ${trust.key} 加入 [trust].trusted)`;
    }
    if (trust.reason === 'matched') {
      return `项目层已加载(命中 ${trust.pattern})`;
    }
    if (trust.reason === 'unrecordable') {
      return '项目层已加载($HOME 或盘根不作信任键,按信任处理)';
    }
    return `项目层已加载(本次记下 ${trust.key})`;
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
    this.currentConfig = {
      ...layered.config,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
    this.applyTheme();
    this.catalog = await loadCatalogFile(join(this.options.home, 'providers.json'));
    const sessionFile =
      options.freshSession === true ? undefined : (options.sessionFile ?? this.runtime?.session.path);
    await this.runtime?.close();
    this.runtime = undefined;
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
    const key = this.approvalKey(target, decision);
    if (this.alwaysAllow.has(key)) {
      return Promise.resolve('allow');
    }
    // 审批需要立即关注:把查看器收起,让审批卡片可见
    this.viewer.close();
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
    let verdict: 'allow' | 'deny' | undefined;
    if (key.type === 'text' && ['y', 'a', 'n'].includes(key.text.toLowerCase())) {
      const choice = key.text.toLowerCase();
      verdict = choice === 'n' ? 'deny' : 'allow';
      if (choice === 'a') {
        this.alwaysAllow.add(this.approvalKey(this.approvalCard.target, this.approvalCard.decision));
      }
    } else if (key.type === 'escape' || key.type === 'ctrl-c') {
      verdict = 'deny';
    }
    if (verdict === undefined) {
      return;
    }
    const resolve = this.approvalResolve;
    this.approvalCard = undefined;
    this.approvalResolve = undefined;
    resolve(verdict);
  }

  private approvalKey(target: RuleTarget, decision: Decision): string {
    return decision.rule ?? `${target.tool}:${target.command ?? target.path ?? target.server ?? ''}`;
  }

  // —— 渲染 ——

  private scheduleRender(): void {
    if (this.exiting || this.renderTimer !== undefined) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  private readonly onResize = (): void => {
    this.terminal.invalidate();
    this.scheduleRender();
  };

  private render(): void {
    const cols = this.terminal.columns;
    const rows = this.terminal.rows;
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
    const scrollback = this.renderScrollbackLines(cols - 1);
    // 欢迎面板独占屏幕时垂直居中;一旦有对话内容就回到顶部对齐,避免最新一行随长度跳动
    const content =
      this.blocks.length === 1 && this.blocks[0]?.kind === 'welcome'
        ? centerVertically(scrollback, mainHeight)
        : scrollback;
    const maxTop = Math.max(0, content.length - mainHeight);
    if (this.follow) {
      this.scrollTop = maxTop;
    }
    const top = Math.min(this.scrollTop, maxTop);
    this.scrollTop = top;
    this.lastMainHeight = mainHeight;
    this.lastMaxTop = maxTop;
    const main = content.slice(top, top + mainHeight);
    while (main.length < mainHeight) {
      main.push('');
    }
    const bar = scrollbarGeometry(top, mainHeight, content.length);
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
   * 信任页整屏:居中的信任内容 + 底部按键。
   *
   * 与欢迎页同一条居中规则;正文过长(矮终端)时保留顶部——提问与路径比清单更要紧。
   */
  private renderTrustFrame(cols: number, rows: number): string[] {
    const theme = this.renderContext.theme;
    const pending = this.trustPrompt;
    if (pending === undefined) {
      return [];
    }
    const separator = theme.paint.muted(symbols.separator.repeat(cols));
    const footer = [
      ...renderTrustMenu(theme),
      theme.paint.muted('  y/n 选择 · 信任后写入 ~/.reins/config.toml 的 [trust].trusted'),
    ];
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

  private renderScrollbackLines(width: number): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(...this.renderer.render(block, width));
    }
    return lines;
  }

  private renderCompletionMenu(width: number, height: number): string[] {
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

  private renderFooter(width: number): { lines: string[]; cursor?: { line: number; column: number } } {
    if (this.approvalCard !== undefined) {
      const paint = this.renderContext.theme.paint;
      const { target, decision } = this.approvalCard;
      const what = target.command ?? target.path ?? target.server ?? target.domain ?? '';
      const lines = [
        paint.warn(`  ${symbols.warn} 审批请求`),
        `    ${this.renderContext.theme.bold(target.tool)}: ${truncatePlain(what, Math.max(0, width - 12))}`,
        paint.muted(`    触发规则:${decision.rule ?? decision.reason}`),
        `    ${paint.ok('[y] 允许')}   ${paint.ok('[a] 本会话总是允许')}   ${paint.fail('[n] 拒绝')}`,
        paint.muted('  y/a/n 选择 · Esc 拒绝'),
      ];
      return { lines };
    }

    const theme = this.renderContext.theme;
    const lines: string[] = [];

    // 输入框:上下边框 + 两侧竖线;光标行列按框内偏移修正
    const input = this.renderInputLines(width);
    const frame = inputBoxFrame(width, theme);
    lines.push(frame.top, ...input.lines.map((line) => inputBoxLine(line, width, theme)), frame.bottom);
    lines.push(this.renderHints(width));
    return {
      lines,
      cursor: { line: 1 + input.cursorLine, column: 2 + input.cursorColumn },
    };
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
      lines.push(`${prefix}${row.text}`);
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

  private renderHints(width: number): string {
    const paint = this.renderContext.theme.paint;
    let text: string;
    const status = this.statusMessage;
    if (status !== undefined && status.until > Date.now()) {
      return paint.warn(` ${truncatePlain(status.text, Math.max(0, width - 2))}`);
    }
    if (this.approvalCard !== undefined) {
      text = 'y/a/n 选择 · Esc 拒绝';
    } else if (this.running) {
      text = `⏱ ${formatElapsed(Date.now() - this.runStartedAt)} · ^C/Esc 中断 · 滚轮/PgUp/PgDn 滚动 · ^O 查看`;
    } else if (!this.follow) {
      text = '⤓ End 回到底部 · 滚轮/PgUp/PgDn 滚动';
    } else {
      text = '⏎ 发送 · ^J 换行 · @ 文件 · Tab 补全 · ↑↓ 历史 · ^E 展开 · ^O 查看 · ^C 中断 · /help';
    }
    return paint.muted(` ${truncatePlain(text, Math.max(0, width - 2))}`);
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
    this.push({ kind: 'notice', text, level });
  }

  /** 运行结束(含中断)后的收尾:停掉流式光标,未完成的工具标记为已中断。 */
  private markRunStopped(aborted: boolean): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last !== undefined && last.kind === 'assistant') {
      last.streaming = false;
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

