import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GlobTool } from '../../src/tools/glob.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('文件查找工具', () => {
  const tool = new GlobTool();
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export {};\n');
    await writeFile(join(dir, 'src', 'deep', 'b.ts'), 'export {};\n');
    await writeFile(join(dir, 'README.md'), '# demo\n');
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('** 递归匹配', async () => {
    const result = await tool.execute({ pattern: '**/*.ts' }, { workspace: dir });
    assert.equal(result.isError, false);
    assert.ok(result.content.includes('src/a.ts'));
    assert.ok(result.content.includes('src/deep/b.ts'));
  });

  it('无分隔符的模式按文件名匹配', async () => {
    const result = await tool.execute({ pattern: '*.md' }, { workspace: dir });
    assert.ok(result.content.includes('README.md'));
    assert.equal(result.content.includes('.ts'), false);
  });

  it('无匹配时给出明确结果', async () => {
    const result = await tool.execute({ pattern: 'nope/*.xyz' }, { workspace: dir });
    assert.ok(result.content.includes('未找到'));
  });
});
