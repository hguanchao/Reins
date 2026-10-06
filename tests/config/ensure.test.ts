import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { parseCatalog } from '../../src/catalog/schema.ts';
import { ensureHomeConfig } from '../../src/config/ensure.ts';
import { parseConfig } from '../../src/config/schema.ts';
import { readTextFile } from '../../src/util/fsx.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('配置自动初始化', () => {
  it('缺失时创建两个文件,且模板能通过校验', async () => {
    const home = await createTmpDir();
    try {
      const result = await ensureHomeConfig(home);
      assert.equal(result.created.length, 2);

      const configRaw = parseToml(await readTextFile(join(home, 'config.toml')));
      const config = parseConfig(configRaw, 'config.toml');
      assert.equal(config.provider, 'example-openai');
      assert.equal(config.model, 'gpt-5.2');

      const catalog = parseCatalog(JSON.parse(await readTextFile(join(home, 'providers.json'))));
      assert.ok(catalog.providers['example-openai'] !== undefined);
    } finally {
      await removeTmpDir(home);
    }
  });

  it('已存在的文件绝不覆盖', async () => {
    const home = await createTmpDir();
    try {
      await writeFile(join(home, 'config.toml'), 'provider = "x"\nmodel = "y"\n');
      const result = await ensureHomeConfig(home);
      assert.equal(result.created.length, 1);
      assert.ok(result.created[0]?.endsWith('providers.json'));
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'provider = "x"\nmodel = "y"\n');
    } finally {
      await removeTmpDir(home);
    }
  });
});
