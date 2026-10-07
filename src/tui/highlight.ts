/**
 * 代码高亮:零依赖的轻量词法扫描。
 *
 * 设计意图:只追求「读起来舒服」而不是编译器级精确——按语言表驱动,
 * 扫描器只有一个;多行注释与跨行字符串通过扫描状态跨行延续;
 * 未知语言直接原样返回,绝不因为高亮而改变文本内容。
 */

export type SyntaxRole = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type';

export interface CodeToken {
  text: string;
  role: SyntaxRole | undefined;
}

interface QuoteDef {
  char: string;
  /** 允许跨行(如 JS 模板串、Python 三引号)。 */
  multiline: boolean;
}

interface LangDef {
  lineComments: readonly string[];
  blockComments?: readonly (readonly [string, string])[];
  quotes: readonly QuoteDef[];
  keywords: ReadonlySet<string>;
  types: ReadonlySet<string>;
  /** 关键字是否大小写不敏感(SQL)。 */
  caseInsensitive?: boolean;
  /** 三引号字符串(Python)。 */
  tripleQuotes?: readonly string[];
}

const set = (words: readonly string[]): ReadonlySet<string> => new Set(words);

const JS_KEYWORDS = set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'async', 'await', 'static', 'get', 'set', 'of', 'from', 'as',
  'interface', 'type', 'enum', 'implements', 'private', 'public', 'protected', 'readonly',
  'namespace', 'declare', 'abstract', 'is', 'keyof', 'infer', 'satisfies',
]);
const JS_TYPES = set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'console', 'window', 'document',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Map', 'Set',
  'Symbol', 'Date', 'RegExp', 'Error', 'process', 'require', 'module', 'Buffer', 'URL',
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'object', 'symbol', 'bigint',
]);

const PY_KEYWORDS = set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);
const PY_TYPES = set([
  'True', 'False', 'None', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'frozenset',
  'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'object', 'type', 'self', 'cls',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
]);

const BASH_KEYWORDS = set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'select', 'in', 'time', 'coproc', 'return', 'exit', 'local', 'export', 'source',
  'set', 'unset', 'alias', 'eval', 'exec', 'trap', 'read', 'echo', 'printf', 'cd',
]);

const GO_KEYWORDS = set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
  'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
  'struct', 'switch', 'type', 'var',
]);
const GO_TYPES = set([
  'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
  'uintptr', 'byte', 'rune', 'float32', 'float64', 'bool', 'error', 'any', 'nil', 'true', 'false', 'iota',
]);

const RUST_KEYWORDS = set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
  'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
  'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while',
]);
const RUST_TYPES = set([
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32',
  'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'Self',
]);

const SQL_KEYWORDS = set([
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
  'table', 'drop', 'alter', 'add', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by',
  'order', 'having', 'limit', 'offset', 'union', 'all', 'distinct', 'as', 'and', 'or', 'not',
  'null', 'is', 'like', 'in', 'between', 'case', 'when', 'then', 'else', 'end', 'primary', 'key',
  'foreign', 'references', 'index', 'view', 'with', 'exists', 'asc', 'desc', 'count', 'sum', 'avg',
  'min', 'max',
]);
const SQL_TYPES = set([
  'int', 'integer', 'varchar', 'char', 'text', 'boolean', 'date', 'timestamp', 'decimal', 'numeric',
  'float', 'real', 'bigint', 'smallint', 'serial', 'uuid', 'json', 'jsonb',
]);

const CLIKE_KEYWORDS = set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'goto', 'struct', 'class', 'enum', 'union', 'typedef', 'sizeof', 'new', 'delete', 'try', 'catch',
  'finally', 'throw', 'throws', 'public', 'private', 'protected', 'static', 'const', 'final',
  'virtual', 'override', 'namespace', 'using', 'template', 'typename', 'this', 'super', 'import',
  'package', 'implements', 'extends', 'interface', 'abstract', 'synchronized', 'volatile',
  'transient', 'native', 'sealed', 'record', 'var', 'lock', 'unsafe', 'foreach', 'fn', 'let',
]);
const CLIKE_TYPES = set([
  'int', 'long', 'short', 'double', 'float', 'char', 'void', 'byte', 'boolean', 'string', 'String',
  'true', 'false', 'null', 'nullptr', 'auto', 'unsigned', 'signed', 'bool', 'usize', 'u32', 'i32',
]);

const YAML_KEYWORDS = set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']);

const LANGS: Readonly<Record<string, LangDef>> = {
  js: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
      { char: '`', multiline: true },
    ],
    keywords: JS_KEYWORDS,
    types: JS_TYPES,
  },
  json: {
    lineComments: [],
    quotes: [{ char: '"', multiline: false }],
    keywords: set(['true', 'false', 'null']),
    types: set([]),
  },
  python: {
    lineComments: ['#'],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    tripleQuotes: ["'''", '"""'],
    keywords: PY_KEYWORDS,
    types: PY_TYPES,
  },
  bash: {
    lineComments: ['#'],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: BASH_KEYWORDS,
    types: set([]),
  },
  go: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
      { char: '`', multiline: true },
    ],
    keywords: GO_KEYWORDS,
    types: GO_TYPES,
  },
  rust: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: RUST_KEYWORDS,
    types: RUST_TYPES,
  },
  sql: {
    lineComments: ['--'],
    blockComments: [['/*', '*/']],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: SQL_KEYWORDS,
    types: SQL_TYPES,
    caseInsensitive: true,
  },
  clike: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: CLIKE_KEYWORDS,
    types: CLIKE_TYPES,
  },
  yaml: {
    lineComments: ['#'],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: YAML_KEYWORDS,
    types: set([]),
  },
  toml: {
    lineComments: ['#'],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: set(['true', 'false']),
    types: set([]),
  },
  css: {
    lineComments: [],
    blockComments: [['/*', '*/']],
    quotes: [
      { char: "'", multiline: false },
      { char: '"', multiline: false },
    ],
    keywords: set(['!important']),
    types: set([]),
  },
};

/** 语言的别名归一:常见扩展名映射到上表。 */
const ALIASES: Readonly<Record<string, string>> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  typescript: 'js', jsonc: 'json', json5: 'json', py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', rs: 'rust',
  c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike', cc: 'clike', java: 'clike', cs: 'clike',
  kotlin: 'clike', kt: 'clike', swift: 'clike', scala: 'clike', php: 'clike', dart: 'clike',
  yml: 'yaml', ini: 'toml', cfg: 'toml', scss: 'css', less: 'css',
};

interface ScanState {
  /** 跨行未闭合的块注释或字符串。 */
  open?: { closer: string; role: SyntaxRole; quote: boolean };
}

const IDENT_RE = /^[A-Za-z_$][\w$]*/;
const NUMBER_RE = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?)/;

/** 把代码按行切成带角色的 token;未识别语言时每行整体无角色。 */
export function highlightCode(code: string, lang: string): CodeToken[][] {
  const name = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  if (name === 'diff') {
    return highlightDiff(code);
  }
  if (name === 'html' || name === 'xml' || name === 'svg') {
    return highlightMarkup(code);
  }
  const def = LANGS[name];
  if (def === undefined) {
    return code.split('\n').map((line) => [{ text: line, role: undefined }]);
  }
  const state: ScanState = {};
  return code.split('\n').map((line) => scanLine(line, def, state));
}

function matchKeyword(def: LangDef, word: string): boolean {
  return def.caseInsensitive === true
    ? def.keywords.has(word.toLowerCase())
    : def.keywords.has(word);
}

function matchType(def: LangDef, word: string): boolean {
  return def.caseInsensitive === true
    ? def.types.has(word.toLowerCase())
    : def.types.has(word);
}

/** 单行扫描:从 state 续接跨行结构,结束时更新 state。 */
function scanLine(line: string, def: LangDef, state: ScanState): CodeToken[] {
  const tokens: CodeToken[] = [];
  let pos = 0;
  const push = (text: string, role: SyntaxRole | undefined): void => {
    if (text === '') {
      return;
    }
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.role === role) {
      last.text += text;
    } else {
      tokens.push({ text, role });
    }
  };

  while (pos < line.length) {
    // 跨行注释/字符串:找到闭合符前整段都属于该结构
    if (state.open !== undefined) {
      const open = state.open;
      const end = line.indexOf(open.closer, pos);
      if (end === -1) {
        push(line.slice(pos), open.role);
        pos = line.length;
      } else {
        push(line.slice(pos, end + open.closer.length), open.role);
        pos = end + open.closer.length;
        state.open = undefined;
      }
      continue;
    }

    const rest = line.slice(pos);
    const lineComment = def.lineComments.find((prefix) => rest.startsWith(prefix));
    if (lineComment !== undefined) {
      push(rest, 'comment');
      break;
    }
    const block = def.blockComments?.find(([open]) => rest.startsWith(open));
    if (block !== undefined) {
      const [open, close] = block;
      const end = rest.indexOf(close, open.length);
      if (end === -1) {
        state.open = { closer: close, role: 'comment', quote: false };
        push(rest, 'comment');
        break;
      }
      push(rest.slice(0, end + close.length), 'comment');
      pos += end + close.length;
      continue;
    }
    const triple = def.tripleQuotes?.find((q) => rest.startsWith(q));
    if (triple !== undefined) {
      const end = rest.indexOf(triple, triple.length);
      if (end === -1) {
        state.open = { closer: triple, role: 'string', quote: true };
        push(rest, 'string');
        break;
      }
      push(rest.slice(0, end + triple.length), 'string');
      pos += end + triple.length;
      continue;
    }
    const quote = def.quotes.find((q) => rest.startsWith(q.char));
    if (quote !== undefined) {
      const escapedEnd = findQuoteEnd(rest, quote.char);
      if (escapedEnd === -1) {
        if (quote.multiline) {
          state.open = { closer: quote.char, role: 'string', quote: true };
        }
        push(rest, 'string');
        break;
      }
      push(rest.slice(0, escapedEnd + quote.char.length), 'string');
      pos += escapedEnd + quote.char.length;
      continue;
    }

    const whitespace = /^\s+/.exec(rest);
    if (whitespace !== null) {
      push(whitespace[0] ?? '', undefined);
      pos += (whitespace[0] ?? '').length;
      continue;
    }

    const number = NUMBER_RE.exec(rest);
    if (number !== null && /^[0-9]/.test(rest)) {
      push(number[0] ?? '', 'number');
      pos += (number[0] ?? '').length;
      continue;
    }

    const ident = IDENT_RE.exec(rest);
    if (ident !== null) {
      const word = ident[0] ?? '';
      const after = rest.slice(word.length).trimStart();
      if (matchKeyword(def, word)) {
        push(word, 'keyword');
      } else if (matchType(def, word)) {
        push(word, 'type');
      } else if (after.startsWith('(')) {
        push(word, 'function');
      } else {
        push(word, undefined);
      }
      pos += word.length;
      continue;
    }

    push(rest[0] ?? '', undefined);
    pos += 1;
  }
  return tokens;
}

/** 找到未转义的引号结尾;找不到返回 -1。 */
function findQuoteEnd(text: string, quote: string): number {
  let index = quote.length;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text.startsWith(quote, index)) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/** diff:整行按增删/头部分类。 */
function highlightDiff(code: string): CodeToken[][] {
  return code.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return [{ text: line, role: 'comment' as SyntaxRole }];
    }
    if (line.startsWith('@@')) {
      return [{ text: line, role: 'comment' as SyntaxRole }];
    }
    if (line.startsWith('+')) {
      return [{ text: line, role: 'string' as SyntaxRole }];
    }
    if (line.startsWith('-')) {
      return [{ text: line, role: 'keyword' as SyntaxRole }];
    }
    return [{ text: line, role: undefined }];
  });
}

/** html/xml:标签名上色、属性字符串上色;不求完整,只求可读。 */
function highlightMarkup(code: string): CodeToken[][] {
  const tokens: CodeToken[][] = [];
  for (const line of code.split('\n')) {
    const row: CodeToken[] = [];
    let pos = 0;
    while (pos < line.length) {
      const open = line.indexOf('<', pos);
      if (open === -1) {
        pushToken(row, line.slice(pos), undefined);
        break;
      }
      pushToken(row, line.slice(pos, open), undefined);
      const close = findTagEnd(line, open);
      if (close === -1) {
        pushToken(row, line.slice(open), undefined);
        break;
      }
      pushTag(row, line.slice(open, close + 1));
      pos = close + 1;
    }
    tokens.push(row);
  }
  return tokens;
}

function findTagEnd(line: string, from: number): number {
  let quote: string | undefined;
  for (let index = from + 1; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function pushTag(row: CodeToken[], tag: string): void {
  const name = /^<(\/?)([\w:.-]+)/.exec(tag);
  if (name === null) {
    pushToken(row, tag, undefined);
    return;
  }
  pushToken(row, `<${name[1] ?? ''}`, undefined);
  pushToken(row, name[2] ?? '', 'keyword');
  const rest = tag.slice((name[0] ?? '').length);
  let pos = 0;
  while (pos < rest.length) {
    const quoteIndex = Math.min(
      ...['"', "'"].map((q) => {
        const found = rest.indexOf(q, pos);
        return found === -1 ? Number.POSITIVE_INFINITY : found;
      }),
    );
    if (!Number.isFinite(quoteIndex)) {
      pushToken(row, rest.slice(pos), undefined);
      break;
    }
    const end = rest.indexOf(rest[quoteIndex] ?? '', quoteIndex + 1);
    const stop = end === -1 ? rest.length : end + 1;
    pushToken(row, rest.slice(pos, quoteIndex), undefined);
    pushToken(row, rest.slice(quoteIndex, stop), 'string');
    pos = stop;
  }
}

function pushToken(row: CodeToken[], text: string, role: SyntaxRole | undefined): void {
  if (text === '') {
    return;
  }
  const last = row[row.length - 1];
  if (last !== undefined && last.role === role) {
    last.text += text;
  } else {
    row.push({ text, role });
  }
}
