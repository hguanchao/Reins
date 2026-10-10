import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptTokens } from '../../src/llm/usage.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';
import { cacheHitRate, formatTokens, renderStatusBar, type StatusBarInfo } from '../../src/tui/status.ts';
import { createTheme } from '../../src/tui/theme.ts';

const theme = createTheme({ color: true });

/** 完整的一份数据:用户确认过的样子。 */
const full: StatusBarInfo = {
  project: 'Reins',
  branch: 'main',
  model: 'deepseek',
  reasoning: 'max',
  promptTokens: 100_000,
  contextWindow: 1_000_000,
  cacheReadTokens: 90_000,
};

function bar(info: Partial<StatusBarInfo> = {}, width = 120): string {
  return stripAnsi(renderStatusBar(width, theme, { ...full, ...info })).trim();
}

describe('状态栏', () => {
  it('六项齐全时按组排布', () => {
    assert.equal(bar(), '📁 Reins · 🌿 main | 🤖 deepseek · 🧠 max | 📊 100K / 1M | ⚡ 90%');
  });

  it('思考强度未配置时整段省略', () => {
    const text = bar({ reasoning: undefined });
    assert.equal(text.includes('🧠'), false);
    assert.ok(text.includes('🤖 deepseek'));
  });

  it('不是 git 仓库时整项省略', () => {
    const text = bar({ branch: undefined });
    assert.equal(text.includes('🌿'), false);
    assert.equal(text, '📁 Reins | 🤖 deepseek · 🧠 max | 📊 100K / 1M | ⚡ 90%');
  });

  it('拿不到的项退化成 —,上下文用量按 0 显示', () => {
    const text = bar({
      model: undefined,
      promptTokens: undefined,
      contextWindow: undefined,
      cacheReadTokens: undefined,
    });
    assert.equal(text, '📁 Reins · 🌿 main | 🤖 — · 🧠 max | 📊 0.0K / — | ⚡ —');
  });

  it('窗口已知而用量还没有时显示 0.0K', () => {
    assert.ok(bar({ promptTokens: undefined }).includes('📊 0.0K / 1M'));
  });

  it('缓存命中率按统一口径的提示词总量算', () => {
    // OpenAI 系:输入已含缓存读,总量就是输入
    const openai = { inputTokens: 100, outputTokens: 1, cacheReadTokens: 90 };
    assert.equal(
      cacheHitRate({ project: 'p', promptTokens: promptTokens(openai), cacheReadTokens: openai.cacheReadTokens }),
      0.9,
    );
    // Anthropic:缓存读、缓存写单列,总量要三者相加
    const anthropic = { inputTokens: 20, outputTokens: 1, cacheReadTokens: 70, cacheWriteTokens: 10 };
    assert.equal(
      cacheHitRate({
        project: 'p',
        promptTokens: promptTokens(anthropic),
        cacheReadTokens: anthropic.cacheReadTokens,
      }),
      0.7,
    );
  });

  it('没有缓存数据或总量为零时不显示命中率', () => {
    assert.equal(cacheHitRate({ project: 'p', promptTokens: 100 }), undefined);
    assert.equal(cacheHitRate({ project: 'p', promptTokens: 0, cacheReadTokens: 0 }), undefined);
    assert.equal(bar({ cacheReadTokens: undefined }).includes('⚡ —'), true);
  });

  it('命中率按 100% 封顶', () => {
    assert.equal(cacheHitRate({ project: 'p', promptTokens: 10, cacheReadTokens: 20 }), 1);
  });

  it('token 数按 1000 进制缩写', () => {
    assert.equal(formatTokens(0), '0.0K');
    assert.equal(formatTokens(500), '0.5K');
    assert.equal(formatTokens(999), '1.0K');
    assert.equal(formatTokens(1000), '1K');
    assert.equal(formatTokens(14_500), '14.5K');
    assert.equal(formatTokens(100_000), '100K');
    assert.equal(formatTokens(128_000), '128K');
    assert.equal(formatTokens(500_000), '500K');
    assert.equal(formatTokens(999_999), '1M');
    assert.equal(formatTokens(1_000_000), '1M');
    assert.equal(formatTokens(1_500_000), '1.5M');
    assert.equal(formatTokens(14_500_000), '14.5M');
    assert.equal(formatTokens(undefined), '—');
  });

  it('窄终端下截断且不超宽', () => {
    const line = renderStatusBar(40, theme, full);
    assert.ok(visibleWidth(line) <= 40, `超宽:${visibleWidth(line)}`);
    assert.ok(stripAnsi(line).startsWith(' 📁 Reins'));
  });

  it('mono 主题下不写颜色转义', () => {
    const plain = renderStatusBar(120, createTheme({ preset: 'mono' }), full);
    assert.equal(plain.includes('\u001b'), false);
  });
});
