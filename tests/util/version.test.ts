import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { VERSION } from '../../src/util/version.ts';

describe('版本号', () => {
  it('取自 package.json,是唯一来源', async () => {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    assert.equal(typeof pkg.version, 'string');
    assert.equal(VERSION, pkg.version);
    assert.notEqual(VERSION, '');
  });
});
