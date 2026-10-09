import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  decideTrust,
  describeOverrides,
  isRecordableRoot,
  readTrustPatterns,
  resolveProjectTrust,
  trustPatternMatch,
} from '../../src/config/trust.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

const win = process.platform === 'win32';

describe('信任判定', () => {
  it('优先级:命中模式 > 键不可记录 > 交互询问 > 未信任', () => {
    const base = { patternMatched: false, keyRecordable: true, interactive: false };
    assert.equal(decideTrust({ ...base, patternMatched: true }), 'trusted');
    assert.equal(decideTrust({ ...base, keyRecordable: false }), 'trusted');
    assert.equal(decideTrust(base), 'untrusted');
    assert.equal(decideTrust({ ...base, interactive: true }), 'prompt');
    // 无 TTY 时即使是陌生目录也不询问
    assert.equal(decideTrust({ ...base, interactive: false, patternMatched: false }), 'untrusted');
    // 命中模式时有没有 TTY 都无所谓
    assert.equal(decideTrust({ ...base, interactive: false, patternMatched: true }), 'trusted');
  });

  it('模式匹配:精确目录、/** 覆盖其下与自身、* 不跨目录', () => {
    const dir = join(homedir(), 'work', 'repo');
    assert.equal(trustPatternMatch(join(homedir(), 'work', 'repo'), dir), true);
    assert.equal(trustPatternMatch(`${join(homedir(), 'work')}/**`, dir), true);
    // /** 也命中该目录本身
    assert.equal(trustPatternMatch(`${join(homedir(), 'work')}/**`, join(homedir(), 'work')), true);
    // * 不跨目录
    assert.equal(trustPatternMatch(`${join(homedir(), 'work')}/*`, join(homedir(), 'work', 'a', 'b')), false);
    assert.equal(trustPatternMatch(`${join(homedir(), 'other')}/**`, dir), false);
  });

  it('模式匹配:不做按文件名匹配任意目录的回退', () => {
    // 权限规则里 "Reins" 会命中任意目录下的 Reins;信任里必须不命中
    assert.equal(trustPatternMatch('Reins', join(homedir(), 'a', 'Reins')), false);
    // 至于 "**/repo" 这类过宽模式:匹配函数按通配语义如实命中,由配置校验要求绝对路径来挡
  });

  it('模式匹配:结尾斜杠与目标规范化后一致', () => {
    const dir = join(homedir(), 'work', 'repo');
    // 目标会被 absolutize 去掉尾斜杠;模式也必须同样处理,否则这条信任永远不生效
    assert.equal(trustPatternMatch(`${dir}/`, dir), true);
    assert.equal(trustPatternMatch(`${join(homedir(), 'work')}/**/`, dir), true);
  });

  it('模式匹配:Windows 下忽略大小写', () => {
    const dir = join(homedir(), 'Work', 'Repo');
    assert.equal(trustPatternMatch(join(homedir(), 'work', 'repo'), dir), win);
  });

  it('$HOME 与文件系统根不可作为信任键', () => {
    assert.equal(isRecordableRoot(homedir()), false);
    assert.equal(isRecordableRoot(join(homedir(), 'work', 'repo')), true);
    if (win) {
      assert.equal(isRecordableRoot('C:\\'), false);
    } else {
      assert.equal(isRecordableRoot('/'), false);
    }
  });

  it('读取信任模式列表', () => {
    assert.deepEqual(readTrustPatterns({ trust: { trusted: ['a', 'b'] } }), ['a', 'b']);
    assert.deepEqual(readTrustPatterns({}), []);
    assert.deepEqual(readTrustPatterns({ trust: 'not-a-table' }), []);
    assert.deepEqual(readTrustPatterns({ trust: { trusted: [1, 'b'] } }), ['b']);
  });
});

describe('覆盖清单', () => {
  it('安全相关键给出「全局 → 项目层」', () => {
    const rows = describeOverrides(
      { approval: 'ask', sandbox: 'workspace' },
      { approval: 'yolo', sandbox: 'off' },
    );
    assert.deepEqual(rows, [
      { label: '审批模式', detail: 'ask → yolo' },
      { label: '沙箱', detail: 'workspace → off' },
    ]);
  });

  it('未声明时用默认值描述,而不是「未设置」', () => {
    const rows = describeOverrides({}, { approval: 'yolo' });
    assert.deepEqual(rows, [{ label: '审批模式', detail: 'ask(默认) → yolo' }]);
  });

  it('权限规则按条数变化描述', () => {
    const rows = describeOverrides(
      { permissions: { deny: ['a', 'b', 'c'] } },
      { permissions: { deny: [], allow: ['x'] } },
    );
    assert.deepEqual(rows, [{ label: '权限规则', detail: 'deny 3 条 → 0 条 · allow 0 条 → 1 条' }]);
  });

  it('MCP 服务器按新增/改写计数并点明会执行命令', () => {
    const rows = describeOverrides(
      { mcp_servers: { keep: { command: 'a' }, edit: { command: 'b' } } },
      { mcp_servers: { keep: { command: 'a' }, edit: { command: 'c' }, added: { command: 'd' } } },
    );
    assert.deepEqual(rows, [{ label: 'MCP 服务器', detail: '新增 1 个 · 改写 1 个(会执行其声明的命令)' }]);
  });

  it('没有实际变化的项不列出来', () => {
    // 项目层把 sandbox 重写成与全局相同的值、把 deny 清成同样 0 条:都不是"会覆盖"
    const rows = describeOverrides(
      { sandbox: 'off', permissions: { deny: [] }, mcp_servers: { a: { command: 'x' } } },
      { sandbox: 'off', permissions: { deny: [] }, mcp_servers: { a: { command: 'x' } } },
    );
    assert.deepEqual(rows, []);
  });

  it('其余键归为一句计数', () => {
    const rows = describeOverrides({}, { ui: { theme: 'dark' }, max_turns: 5, spill_threshold: 0 });
    assert.deepEqual(rows, [{ label: '其他', detail: '3 项(界面、上下文等)' }]);
  });
});

describe('信任解析(端到端)', () => {
  let home = '';
  let workspace = '';

  before(async () => {
    home = await createTmpDir();
    workspace = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(home);
    await removeTmpDir(workspace);
  });

  async function writeGlobal(text: string): Promise<void> {
    await writeFile(join(home, 'config.toml'), text);
  }

  async function writeProject(text: string): Promise<void> {
    await mkdir(join(workspace, '.reins'), { recursive: true });
    await writeFile(join(workspace, '.reins', 'config.toml'), text);
  }

  it('陌生目录无 TTY 时按未信任处理(fail-closed)', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await removeTmpDir(join(workspace, '.reins'));
    const resolution = await resolveProjectTrust({ home, workspace, interactive: false });
    assert.equal(resolution.projectAllowed, false);
    assert.equal(resolution.reason, 'non-interactive');
  });

  it('信任的是目录本身:没有项目层配置也照样询问', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await removeTmpDir(join(workspace, '.reins'));
    let asked = 0;
    const resolution = await resolveProjectTrust({
      home,
      workspace,
      interactive: true,
      prompt: async () => {
        asked += 1;
        return true;
      },
    });
    assert.equal(asked, 1);
    assert.equal(resolution.projectAllowed, true);
    assert.equal(resolution.reason, 'recorded');
    assert.deepEqual(resolution.overrides, []);
  });

  it('项目层只有空数组时覆盖清单为空,但仍然询问', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await writeProject('permissions = { deny = [] }\n');
    let asked = 0;
    await resolveProjectTrust({
      home,
      workspace,
      interactive: true,
      prompt: async () => {
        asked += 1;
        return false;
      },
    });
    assert.equal(asked, 1);
  });

  it('有会生效的配置且无 TTY 时按未信任处理,并列出覆盖项', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await writeProject('approval = "yolo"\n');
    const resolution = await resolveProjectTrust({ home, workspace, interactive: false });
    assert.equal(resolution.projectAllowed, false);
    assert.equal(resolution.reason, 'non-interactive');
    assert.deepEqual(resolution.overrides, [{ label: '审批模式', detail: 'ask(默认) → yolo' }]);
  });

  it('命中 trusted 模式时信任,并说明命中的是哪个模式', async () => {
    await writeGlobal(`provider = "p"\nmodel = "m"\n\n[trust]\ntrusted = ['${workspace}']\n`);
    const resolution = await resolveProjectTrust({ home, workspace, interactive: false });
    assert.equal(resolution.projectAllowed, true);
    assert.equal(resolution.reason, 'matched');
    assert.equal(resolution.pattern, workspace);
  });

  it('交互下询问:接受则记录并信任,拒绝则未信任', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await writeProject('approval = "yolo"\n');
    const recorded: string[] = [];
    const accepted = await resolveProjectTrust({
      home,
      workspace,
      interactive: true,
      prompt: async () => true,
      record: async (pattern) => {
        recorded.push(pattern);
      },
    });
    assert.equal(accepted.projectAllowed, true);
    assert.equal(accepted.reason, 'recorded');
    assert.deepEqual(recorded, [workspace]);

    const declined = await resolveProjectTrust({
      home,
      workspace,
      interactive: true,
      prompt: async () => false,
      record: async (pattern) => {
        recorded.push(pattern);
      },
    });
    assert.equal(declined.projectAllowed, false);
    assert.equal(declined.reason, 'declined');
    // 拒绝不写记录
    assert.deepEqual(recorded, [workspace]);
  });

  it('--trust 跳过询问并记下路径', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await writeProject('approval = "yolo"\n');
    const recorded: string[] = [];
    const resolution = await resolveProjectTrust({
      home,
      workspace,
      interactive: false,
      force: true,
      prompt: async () => false,
      record: async (pattern) => {
        recorded.push(pattern);
      },
    });
    assert.equal(resolution.projectAllowed, true);
    assert.equal(resolution.reason, 'recorded');
    assert.deepEqual(recorded, [workspace]);
  });

  it('项目层语法损坏时按「有配置」处理并给出可读说明', async () => {
    await writeGlobal('provider = "p"\nmodel = "m"\n');
    await writeProject('approval = = "yolo"\n');
    const resolution = await resolveProjectTrust({ home, workspace, interactive: false });
    assert.equal(resolution.projectAllowed, false);
    assert.equal(resolution.overrides.length, 1);
    assert.ok(resolution.overrides[0]?.detail.includes('解析失败'));
  });
});
