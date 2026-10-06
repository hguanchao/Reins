import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadLayeredConfig } from '../../src/config/layers.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('配置分层', () => {
  let home = '';
  let cwd = '';

  before(async () => {
    home = await createTmpDir();
    cwd = await createTmpDir();
    await writeFile(
      join(home, 'config.toml'),
      [
        'provider = "global-provider"',
        'model = "m1"',
        'max_retries = 3',
        '[permissions]',
        'deny = ["bash(rm *)"]',
        '',
      ].join('\n'),
    );
    await mkdir(join(cwd, '.reins'), { recursive: true });
    await writeFile(
      join(cwd, '.reins', 'config.toml'),
      ['model = "m2"', '', '[ui]', 'notify = "off"', ''].join('\n'),
    );
  });

  after(async () => {
    await removeTmpDir(home);
    await removeTmpDir(cwd);
  });

  it('项目层覆盖全局层,未覆盖字段继承', async () => {
    const { config, files } = await loadLayeredConfig({ home, cwd });
    assert.equal(files.length, 2);
    assert.equal(config.provider, 'global-provider');
    assert.equal(config.model, 'm2');
    assert.equal(config.maxRetries, 3);
    assert.deepEqual(config.permissions.deny, ['bash(rm *)']);
    assert.equal(config.ui.notify, 'off');
  });

  it('无项目层时只加载全局', async () => {
    const emptyCwd = await createTmpDir();
    try {
      const { files } = await loadLayeredConfig({ home, cwd: emptyCwd });
      assert.equal(files.length, 1);
    } finally {
      await removeTmpDir(emptyCwd);
    }
  });
});
