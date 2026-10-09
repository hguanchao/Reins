import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveRealPath } from '../../src/tools/realpath.ts';
import { isWithin } from '../../src/util/paths.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

/**
 * 目录链接的类型:Windows 下用 junction(无需管理员权限即可创建),
 * 其他平台直接用目录符号链接。
 */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

describe('真实路径解析', () => {
  let root = '';
  let outside = '';

  before(async () => {
    root = await createTmpDir();
    outside = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(root);
    await removeTmpDir(outside);
  });

  it('已存在的路径穿过符号链接解析到真实位置', async () => {
    const real = join(root, 'real');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'file.txt'), '内容', 'utf8');
    const link = join(root, 'link');
    await symlink(real, link, LINK_TYPE);

    assert.equal(await resolveRealPath(join(link, 'file.txt')), await realpath(join(real, 'file.txt')));
  });

  it('不存在的尾段拼回最近的已存在祖先之后', async () => {
    const real = join(root, 'real');
    const link = join(root, 'link');
    const expected = join(await realpath(real), 'missing', 'a.txt');

    assert.equal(await resolveRealPath(join(link, 'missing', 'a.txt')), expected);
  });

  it('无链接时结果等于绝对路径的真实形式', async () => {
    assert.equal(await resolveRealPath(join(root, 'nope.txt')), join(await realpath(root), 'nope.txt'));
  });

  it('相对路径按当前目录转成绝对路径', async () => {
    const resolved = await resolveRealPath('some-relative-file.txt');
    assert.equal(isAbsolute(resolved), true);
  });

  it('工作区内的符号链接指向区外时,字面路径在区内而真实路径在区外', async () => {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const escape = join(workspace, 'escape');
    await symlink(outside, escape, LINK_TYPE);
    const literal = join(escape, 'secret.txt');

    // 只看字面路径,沙箱会认为这是工作区内的写入
    assert.equal(isWithin(workspace, literal), true);
    // 解析真实路径后才看得出它落在工作区之外
    const real = await resolveRealPath(literal);
    assert.equal(isWithin(workspace, real), false);
    assert.equal(real, join(await realpath(outside), 'secret.txt'));
  });

  it('指向工作区内部的符号链接不算越界', async () => {
    const workspace = join(root, 'inner-workspace');
    const target = join(workspace, 'target');
    await mkdir(target, { recursive: true });
    const link = join(workspace, 'inside-link');
    await symlink(target, link, LINK_TYPE);

    const real = await resolveRealPath(join(link, 'file.txt'));
    assert.equal(isWithin(workspace, real), true);
  });
});
