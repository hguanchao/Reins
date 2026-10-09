import { basename } from 'node:path';
import { splitShellCommand } from './rules.ts';

/**
 * 只读命令判定与命令前缀提取。
 *
 * 为什么需要:审批的价值在于拦住会改变系统状态的操作,而 `ls`、`cat`、`git status`
 * 这类命令只是看。逐条审批只会让人闭着眼睛按 y,反而把真正危险的审批淹掉。
 *
 * 判定一律 fail-closed:名单之外、判不准的写法都算不安全,走审批。想更严就把
 * 只读命令也写进 `[permissions]` 的 ask 规则——规则优先级高于这层兜底。
 */

/** 只看不写、不联网、不提权的命令。 */
const READ_ONLY_COMMANDS = new Set([
  // 列目录、看内容、看变量
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'more',
  'less',
  'pwd',
  'cd',
  'echo',
  'set',
  'ver',
  'vol',
  'chcp',
  'wc',
  'nl',
  'od',
  'xxd',
  'strings',
  'column',
  'tree',
  // 查文件与路径
  'stat',
  'file',
  'find',
  'du',
  'df',
  'where',
  'which',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'id',
  'groups',
  // 文本检索与比较
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'findstr',
  'diff',
  'cmp',
  'fc',
  'comp',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
  'md5sum',
  'sha1sum',
  'sha256sum',
  // 看进程与系统
  'ps',
  'tasklist',
  'systeminfo',
  'ipconfig',
  'whoami',
  'hostname',
  'uname',
  'uptime',
  'free',
  'nproc',
  'locale',
]);

/** 这些命令本身只读,但带上写参数就会改东西,出现即判不安全。 */
const WRITE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  sort: ['-o', '--output'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
};

/** git 里纯查询的子命令。 */
const GIT_READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'describe',
  'blame',
  'annotate',
  'shortlog',
  'whatchanged',
  'ls-files',
  'ls-tree',
  'cat-file',
  'show-ref',
  'for-each-ref',
  'name-rev',
  'grep',
  'count-objects',
  'fsck',
  'merge-base',
  'cherry',
  'show-branch',
  'version',
]);

/** 既有读也有写的 git 子命令:只放行明确只读的写法。 */
const GIT_CONDITIONAL: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  branch: (args) => !args.some((arg) => /^(-d|-D|-m|-M|-c|-C|-u|-f|--delete|--move|--copy|--force|--set-upstream.*|--edit-description|--unset-upstream)$/.test(arg)),
  tag: (args) => !args.some((arg) => /^(-d|-a|-s|-f|-m|--delete|--annotate|--sign|--force)$/.test(arg)),
  // 裸 `git stash` 是存档(写操作),只有 list/show 是看
  stash: (args) => args[0] === 'list' || args[0] === 'show',
  worktree: (args) => args.length === 0 || args[0] === 'list',
  reflog: (args) => args.length === 0 || args[0] === 'show',
  remote: (args) => args.length === 0 || args[0] === '-v' || args[0] === 'show' || args[0] === 'get-url',
  notes: (args) => args.length === 0 || args[0] === 'list' || args[0] === 'show',
  config: (args) => args.some((arg) => ['-l', '--list', '--get', '--get-all', '--get-regexp'].includes(arg)),
};

/** 需要两个词才说得清的命令(第二词是子命令),记前缀时多带一个词。 */
const MULTI_WORD_COMMANDS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'bun',
  'deno',
  'node',
  'cargo',
  'go',
  'dotnet',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'make',
  'mvn',
  'gradle',
  'docker',
  'kubectl',
  'gh',
  'terraform',
  'helm',
  'systemctl',
  'apt',
  'apt-get',
  'brew',
  'winget',
]);

/**
 * 整条命令是否只读。
 *
 * 分段判定:`ls && rm -rf x` 里只要有一段不安全,整条都算不安全。
 * 重定向与命令替换能把只读命令变成写操作或任意执行,出现即判不安全。
 */
export function isReadOnlyCommand(command: string): boolean {
  if (/[>`]/.test(command) || command.includes('$(')) {
    return false;
  }
  const segments = splitShellCommand(command);
  if (segments.length === 0) {
    return false;
  }
  return segments.every(isReadOnlySegment);
}

/**
 * 命令前缀:给会话内「总是允许」用。
 *
 * 记整条命令没用(换个参数又问一次),只记首词又太宽(`git` 会把 push 一起放行),
 * 所以已知的多词命令取到子命令,其余取首词。
 *
 * 拼接命令不记前缀:`ls && rm -rf x` 记住 `ls *` 之后,`ls && rm -rf y` 也不会再问。
 */
export function commandPrefix(command: string): string | undefined {
  const segments = splitShellCommand(command);
  if (segments.length !== 1) {
    return undefined;
  }
  const tokens = tokenize(segments[0] as string);
  const head = tokens[0];
  if (head === undefined) {
    return undefined;
  }
  const name = commandName(head);
  if (!MULTI_WORD_COMMANDS.has(name)) {
    return name;
  }
  const sub = tokens[1];
  // 第二词是参数(`node -e`、`git --version`)时退回命令名本身
  return sub === undefined || sub.startsWith('-') ? name : `${name} ${sub}`;
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = tokenize(segment);
  const head = tokens[0];
  if (head === undefined) {
    return false;
  }
  const name = commandName(head);
  if (name === 'git') {
    return isReadOnlyGit(tokens.slice(1));
  }
  if (name === 'date') {
    // 只认查询写法:`date`、`date -u`、`date +%F`、`date /t`;带裸参数是设置系统时间
    return tokens.slice(1).every((token) => token.startsWith('-') || token.startsWith('+') || token.startsWith('/'));
  }
  const writeFlags = WRITE_FLAGS[name];
  if (writeFlags !== undefined && tokens.some((token) => writeFlags.includes(token))) {
    return false;
  }
  return READ_ONLY_COMMANDS.has(name);
}

function isReadOnlyGit(args: readonly string[]): boolean {
  let index = 0;
  // 跳过 --no-pager 这类不影响语义的全局开关
  while (args[index] === '--no-pager') {
    index += 1;
  }
  const sub = args[index];
  if (sub === undefined || sub.startsWith('-')) {
    return false;
  }
  const rest = args.slice(index + 1);
  if (GIT_READ_ONLY.has(sub)) {
    return true;
  }
  const conditional = GIT_CONDITIONAL[sub];
  return conditional === undefined ? false : conditional(rest);
}

function tokenize(segment: string): string[] {
  return segment.split(/\s+/).filter((token) => token !== '');
}

/** 取命令名:去掉路径与 Windows 的 .exe 后缀,便于比对名单。 */
function commandName(token: string): string {
  const base = basename(token.replace(/\\/g, '/')).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}
