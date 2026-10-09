import { ConfigError } from './errors.ts';

/** 描述运行时值的类型,用于生成可读的校验错误。 */
function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return '数组';
  }
  return typeof value === 'object' ? '对象' : typeof value;
}

export interface StringOpts {
  required?: boolean;
  values?: readonly string[];
  pattern?: RegExp;
}

export interface NumberOpts {
  required?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
}

export interface BoolOpts {
  required?: boolean;
}

export interface ObjectOpts {
  required?: boolean;
}

export interface ArrayOpts {
  required?: boolean;
}

/**
 * 字段校验器。
 *
 * 设计意图:配置来自用户手写的文件,一次性收集全部问题远比逐个报错友好;
 * 因此校验过程不抛异常,最后统一 throw 一个带文件名与修复提示的错误。
 */
export class Checker {
  readonly issues: string[] = [];
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  hasErrors(): boolean {
    return this.issues.length > 0;
  }

  fail(path: string, message: string): void {
    this.issues.push(`${path} ${message}`);
  }

  /** 汇总所有问题并抛出;无问题时静默返回。 */
  done(): void {
    if (this.issues.length === 0) {
      return;
    }
    const head = `${this.file} 校验失败,共 ${this.issues.length} 处问题:`;
    const body = this.issues.map((issue) => `  - ${issue}`).join('\n');
    throw new ConfigError(
      `${head}\n${body}`,
      '请修正上述字段后重试;运行 `reins config check` 可复检。',
    );
  }

  private raw(
    source: Record<string, unknown>,
    key: string,
    path: string,
    required: boolean,
  ): unknown {
    const value = source[key];
    if (value === undefined || value === null) {
      if (required) {
        this.fail(path, '缺少必填字段');
      }
      return undefined;
    }
    return value;
  }

  string(
    source: Record<string, unknown>,
    key: string,
    path: string,
    opts: StringOpts = {},
  ): string | undefined {
    const value = this.raw(source, key, path, opts.required === true);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      this.fail(path, `应为字符串,实际为 ${typeName(value)}`);
      return undefined;
    }
    if (opts.values && !opts.values.includes(value)) {
      this.fail(path, `取值必须是 ${opts.values.join(' | ')} 之一,实际为 "${value}"`);
      return undefined;
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      this.fail(path, `格式不合法:"${value}"`);
      return undefined;
    }
    return value;
  }

  number(
    source: Record<string, unknown>,
    key: string,
    path: string,
    opts: NumberOpts = {},
  ): number | undefined {
    const value = this.raw(source, key, path, opts.required === true);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number') {
      this.fail(path, `应为数字,实际为 ${typeName(value)}`);
      return undefined;
    }
    if (!Number.isFinite(value)) {
      this.fail(path, '应为有限数字(不能是 Infinity 或 NaN)');
      return undefined;
    }
    if (opts.integer && !Number.isInteger(value)) {
      this.fail(path, '应为整数');
      return undefined;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(path, `不得小于 ${opts.min}`);
      return undefined;
    }
    if (opts.max !== undefined && value > opts.max) {
      this.fail(path, `不得大于 ${opts.max}`);
      return undefined;
    }
    return value;
  }

  boolean(
    source: Record<string, unknown>,
    key: string,
    path: string,
    opts: BoolOpts = {},
  ): boolean | undefined {
    const value = this.raw(source, key, path, opts.required === true);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'boolean') {
      this.fail(path, `应为布尔值,实际为 ${typeName(value)}`);
      return undefined;
    }
    return value;
  }

  stringArray(
    source: Record<string, unknown>,
    key: string,
    path: string,
    opts: ArrayOpts = {},
  ): string[] | undefined {
    const value = this.raw(source, key, path, opts.required === true);
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.fail(path, `应为字符串数组,实际为 ${typeName(value)}`);
      return undefined;
    }
    const result: string[] = [];
    value.forEach((item, index) => {
      if (typeof item !== 'string') {
        this.fail(`${path}[${index}]`, `应为字符串,实际为 ${typeName(item)}`);
        return;
      }
      result.push(item);
    });
    return result;
  }

  object(
    source: Record<string, unknown>,
    key: string,
    path: string,
    opts: ObjectOpts = {},
  ): Record<string, unknown> | undefined {
    const value = this.raw(source, key, path, opts.required === true);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.fail(path, `应为对象,实际为 ${typeName(value)}`);
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  /** 校验一个字符串到字符串的映射(用于 headers 等)。 */
  stringMap(
    source: Record<string, unknown>,
    key: string,
    path: string,
    opts: ObjectOpts = {},
  ): Record<string, string> | undefined {
    const record = this.object(source, key, path, opts);
    if (record === undefined) {
      return undefined;
    }
    const result: Record<string, string> = {};
    for (const [mapKey, mapValue] of Object.entries(record)) {
      if (typeof mapValue !== 'string') {
        this.fail(`${path}.${mapKey}`, `应为字符串,实际为 ${typeName(mapValue)}`);
        continue;
      }
      result[mapKey] = mapValue;
    }
    return result;
  }
}
