import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadLayeredConfig } from '../../src/config/layers.ts';
import { ConfigError } from '../../src/util/errors.ts';
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
    const { config, files } = await loadLayeredConfig({ home, cwd, projectLayer: 'allow' });
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
      const { files } = await loadLayeredConfig({ home, cwd: emptyCwd, projectLayer: 'allow' });
      assert.equal(files.length, 1);
    } finally {
      await removeTmpDir(emptyCwd);
    }
  });

  it('未信任(ignore)时项目层完全不生效', async () => {
    const { config, files } = await loadLayeredConfig({ home, cwd, projectLayer: 'ignore' });
    assert.equal(files.length, 1);
    // 项目层的 model 与 ui.notify 都不生效
    assert.equal(config.model, 'm1');
    assert.equal(config.ui.notify, 'auto');
  });

  it('项目层声明 [trust] 时报错:信任只能写在全局层', async () => {
    const badCwd = await createTmpDir();
    try {
      await mkdir(join(badCwd, '.reins'), { recursive: true });
      await writeFile(
        join(badCwd, '.reins', 'config.toml'),
        "trust = { trusted = ['/anywhere'] }\n",
      );
      await assert.rejects(
        () => loadLayeredConfig({ home, cwd: badCwd, projectLayer: 'allow' }),
        (error: unknown) => error instanceof ConfigError && error.message.includes('[trust]'),
      );
    } finally {
      await removeTmpDir(badCwd);
    }
  });
});
