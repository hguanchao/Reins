import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InputEditor } from '../../src/tui/editor.ts';
import { createFileIndex, needsFileScan, rankFileCandidates } from '../../src/tui/files.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

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

  it('目录项按名称匹配,不被结尾斜杠干扰', () => {
    const entries = ['src/tui/', 'src/tui/app.ts', 'src/config/schema.ts'];
    assert.equal(rankFileCandidates(entries, 'tui', 5)[0], 'src/tui/');
    // 查询以 / 结尾时只列其下内容,不再列目录自身
    assert.deepEqual(rankFileCandidates(entries, 'src/tui/', 5), ['src/tui/app.ts']);
  });
});

describe('@ 文件索引', () => {
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'app.ts'), '');
    await writeFile(join(dir, 'README.md'), '');
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('空索引视为过期,扫描后列出工作区文件', async () => {
    const index = createFileIndex(dir);
    // 空索引必须算过期,否则上层不会发起扫描
    assert.equal(index.stale(), true);
    assert.deepEqual(index.list(), []);
    await index.refresh();
    assert.equal(index.stale(), false);
    const listed = [...index.list()];
    assert.ok(listed.includes('README.md'), listed.join(','));
    assert.ok(listed.includes('src/app.ts'), listed.join(','));
    // 目录也在候选里,且以 '/' 结尾以便与文件区分
    assert.ok(listed.includes('src/'), listed.join(','));
  });

  it('首次输入 @ 就能触发扫描并给出候选', async () => {
    const index = createFileIndex(dir);
    const editor = new InputEditor({ commands: [], files: () => index.list() });
    editor.insert('看看 @');
    // 旧实现拿「已出现 mention 补全」当刷新条件,而空索引下补全恒为空,于是永远不扫描
    const beforeScan = editor.completionState;
    assert.equal(beforeScan, null);
    // 走上层的真实判断与流程
    if (needsFileScan(editor.mentionQuery(), index.stale())) {
      await index.refresh();
      editor.refreshCompletion();
    }
    const completion = editor.completionState;
    if (completion === null) throw new Error('扫描后应出现候选');
    assert.ok(completion.items.includes('src/app.ts'), completion.items.join(','));
  });
});

describe('@ 扫描触发条件', () => {
  it('空索引下的 @ 词条必须触发扫描', () => {
    // 这正是首次按 @ 出不来候选的原因:索引为空但补全也为空,只能靠输入文本判定
    assert.equal(needsFileScan('', true), true);
    assert.equal(needsFileScan('app', true), true);
  });

  it('不在 @ 词条内或快照新鲜时不扫描', () => {
    assert.equal(needsFileScan(null, true), false);
    assert.equal(needsFileScan('', false), false);
    assert.equal(needsFileScan(null, false), false);
  });
});
