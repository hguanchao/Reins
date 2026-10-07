import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankFileCandidates } from '../../src/tui/files.ts';

const files = [
  'src/tui/app.ts',
  'src/tui/blocks.ts',
  'src/tui/theme.ts',
  'src/config/schema.ts',
  'README.md',
  'docs/architecture.md',
];

describe('@ 文件候选', () => {
  it('空查询按字典序截取', () => {
    const ranked = rankFileCandidates(files, '', 4);
    assert.deepEqual(ranked, [
      'README.md',
      'docs/architecture.md',
      'src/config/schema.ts',
      'src/tui/app.ts',
    ]);
  });

  it('文件名前缀优先于路径包含', () => {
    const ranked = rankFileCandidates(['src/theme/note.md', 'theme.ts'], 'theme', 5);
    assert.equal(ranked[0], 'theme.ts');
  });

  it('文件名包含优先于路径包含', () => {
    const ranked = rankFileCandidates(['src/theme-util.ts', 'src/theme/deep/other.ts'], 'theme', 5);
    assert.equal(ranked[0], 'src/theme-util.ts');
  });

  it('大小写不敏感且接受路径片段', () => {
    const ranked = rankFileCandidates(files, 'TUI/BL', 5);
    assert.deepEqual(ranked, ['src/tui/blocks.ts']);
  });

  it('不匹配的文件被过滤,limit 生效', () => {
    assert.deepEqual(rankFileCandidates(files, 'zzz', 3), []);
    assert.equal(rankFileCandidates(files, '', 2).length, 2);
    assert.deepEqual(rankFileCandidates(files, '', 0), []);
  });
});
