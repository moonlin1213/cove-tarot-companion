import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { install } from '../scripts/install.mjs';
import { loadConfig, writeConfig } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
const cliScript = fileURLToPath(new URL('../scripts/companion.mjs', import.meta.url));
async function waitForFile(filename) {
  for (let i = 0; i < 500; i++) {
    try { await fs.stat(filename); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('fixture did not reach its real filesystem switch');
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion install 占卜-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global'), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  await run('git', ['init', source], { env });
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"fixture-engine","version":"1.0.0","type":"module"}');
  await fs.writeFile(path.join(source, 'package-lock.json'), '{"name":"fixture-engine","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture-engine","version":"1.0.0"}}}');
  await fs.writeFile(path.join(source, 'server.mjs'), 'process.exit(0);');
  await fs.writeFile(path.join(source, '.gitignore'), '*.custom\n');
  await run('git', ['-C', source, 'add', '.'], { env });
  await run('git', ['-C', source, 'commit', '-m', 'fixture'], { env });
  const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'], { env })).stdout.trim();
  const packageRoot = path.join(root, 'package'); await fs.mkdir(packageRoot);
  for (const name of ['src', 'scripts', 'public', 'package.json']) await fs.cp(new URL('../' + name, import.meta.url), path.join(packageRoot, name), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'engine-lock.json'), JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit }));
  await fs.mkdir(path.join(packageRoot, '.superpowers')); await fs.writeFile(path.join(packageRoot, '.superpowers/private'), 'PRIVATE');
  for (const relative of ['README.en.md', 'THIRD_PARTY_NOTICES.md', 'agents/openai.yaml', 'references/host-integration.md']) {
    await fs.mkdir(path.dirname(path.join(packageRoot, relative)), { recursive: true });
    await fs.writeFile(path.join(packageRoot, relative), 'Public fixture documentation');
  }
  Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${source}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/moonlin1213/tarot-ritual.git' });
  return { root, packageRoot, dataDir: path.join(root, 'data'), skillDir: path.join(root, 'skill'), environment: env, commit };
}

test('pinned real-Git install is idempotent, isolated, and preserves data across update/uninstall', async t => {
  const options = await fixture(t);
  const first = await install(options);
  const config = await loadConfig(options.dataDir);
  assert.equal(first.commit, options.commit);
  assert.equal(config.engineRoot, path.join(options.skillDir, 'engine'));
  await assert.rejects(fs.stat(path.join(options.skillDir, '.superpowers')), { code: 'ENOENT' });
  for (const relative of ['README.en.md', 'THIRD_PARTY_NOTICES.md', 'agents/openai.yaml', 'references/host-integration.md']) assert.equal(await fs.readFile(path.join(options.skillDir, relative), 'utf8'), 'Public fixture documentation');
  await fs.writeFile(path.join(options.dataDir, 'saved-record'), 'preserve');
  assert.equal((await install(options)).state, 'unchanged');
  assert.equal((await loadConfig(options.dataDir)).adminToken, config.adminToken);
  await install({ ...options, update: true });
  assert.equal((await loadConfig(options.dataDir)).origin, config.origin);
  const result = await install({ ...options, uninstall: true });
  assert.equal(result.state, 'uninstalled');
  assert.equal(await fs.readFile(path.join(options.dataDir, 'saved-record'), 'utf8'), 'preserve');
  await assert.rejects(fs.stat(options.skillDir), { code: 'ENOENT' });
  assert.ok(result.retainedCode);
});

test('untracked ignored additions and edited code block replacement and remain intact on uninstall', async t => {
  const options = await fixture(t); await install(options);
  await fs.writeFile(path.join(options.skillDir, 'engine/artwork.custom'), 'custom artwork');
  await assert.rejects(install({ ...options, update: true }), /modified/i);
  const result = await install({ ...options, uninstall: true });
  assert.equal(result.state, 'retained-modified');
  assert.equal(await fs.readFile(path.join(options.skillDir, 'engine/artwork.custom'), 'utf8'), 'custom artwork');
});

test('unsafe destinations and non-owned directories are rejected without overwrites', async t => {
  const options = await fixture(t);
  await fs.mkdir(options.skillDir); await fs.writeFile(path.join(options.skillDir, 'mine'), 'mine');
  await assert.rejects(install(options), /owned/i);
  assert.equal(await fs.readFile(path.join(options.skillDir, 'mine'), 'utf8'), 'mine');
  await assert.rejects(install({ ...options, skillDir: options.dataDir }), /separate|overlap/i);
  await assert.rejects(install({ ...options, skillDir: '/' }), /unsafe/i);
  await fs.symlink(options.skillDir, path.join(options.root, 'link'));
  await assert.rejects(install({ ...options, skillDir: path.join(options.root, 'link') }), /symlink/i);
});

test('real installer rejects equality and nesting in both directions for every code/data/source pair before side effects', async t => {
  const cases = [
    ['skill equals data', async options => ({ skillDir: options.dataDir })],
    ['data under skill', async options => ({ dataDir: path.join(options.skillDir, 'data') })],
    ['skill under data', async options => ({ skillDir: path.join(options.dataDir, 'skill') })],
    ['skill equals package', async options => ({ skillDir: options.packageRoot })],
    ['skill under package', async options => ({ skillDir: path.join(options.packageRoot, 'skill') })],
    ['package under skill', async options => {
      const skillDir = path.join(options.root, 'code-parent');
      const packageRoot = path.join(skillDir, 'package');
      await fs.mkdir(skillDir); await fs.rename(options.packageRoot, packageRoot);
      return { skillDir, packageRoot };
    }],
    ['data equals package', async options => ({ dataDir: options.packageRoot })],
    ['data under package', async options => ({ dataDir: path.join(options.packageRoot, 'data') })],
    ['package under data', async options => {
      const dataDir = path.join(options.root, 'data-parent');
      const packageRoot = path.join(dataDir, 'package');
      await fs.mkdir(dataDir); await fs.rename(options.packageRoot, packageRoot);
      return { dataDir, packageRoot };
    }],
  ];
  for (const [name, prepare] of cases) await t.test(name, async t => {
    const options = await fixture(t);
    const selected = { ...options, ...await prepare(options) };
    await assert.rejects(install(selected), /separate|overlap/i);
    try {
      const entries = await fs.readdir(path.dirname(selected.skillDir));
      assert.equal(entries.some(entry => entry.startsWith('.companion-stage-')), false, 'overlap rejection must precede staging');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    async function assertNoInstallerPrivateFiles(directory) {
      try {
        const names = await fs.readdir(directory);
        assert.equal(names.includes('.install.lock'), false);
        assert.equal(names.includes('config.json'), false);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await assertNoInstallerPrivateFiles(selected.dataDir);
  });
});

test('native macOS installer catches initially-missing case aliases after required parent creation', async t => {
  if (process.platform !== 'darwin') return;
  const options = await fixture(t);
  const probe = path.join(options.root, 'CaseProbe');
  await fs.mkdir(probe);
  try {
    try { await fs.lstat(path.join(options.root, 'caseprobe')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  } finally { await fs.rmdir(probe); }
  const skillDir = path.join(options.root, 'CaseIdentity');
  const dataDir = path.join(options.root, 'caseidentity', 'private-data');
  await assert.rejects(install({ ...options, skillDir, dataDir }), /separate|overlap/i);
  assert.equal((await fs.readdir(options.root)).some(entry => entry.startsWith('.companion-stage-')), false);
});

test('installer reapplies unsafe root, canonical home and cwd guards without writing those destinations', async t => {
  const options = await fixture(t);
  await assert.rejects(install({ ...options, skillDir: path.parse(options.root).root }), /unsafe/i);
  if (process.platform !== 'darwin') return;
  const caseAlias = value => {
    const parts = value.split(path.sep);
    const index = parts.findIndex(Boolean);
    parts[index] = [...parts[index]].map(character => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()).join('');
    return parts.join(path.sep);
  };
  for (const target of [os.homedir(), process.cwd()]) {
    const alias = caseAlias(target);
    try { await fs.lstat(alias); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await assert.rejects(install({ ...options, skillDir: alias }), /unsafe/i);
  }
});

test('missing/wrong pin and failed npm ci never switch a working config or overwrite code', async t => {
  const options = await fixture(t); await install(options);
  const before = await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8');
  const manifest = path.join(options.packageRoot, 'engine-lock.json');
  await fs.writeFile(manifest, JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit: '0'.repeat(40) }));
  await assert.rejects(install({ ...options, update: true }), /pin|commit|available/i);
  assert.equal(await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8'), before);
  assert.ok(await fs.stat(path.join(options.skillDir, 'scripts/companion.mjs')));
  await fs.writeFile(manifest, JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit: 'main' }));
  await assert.rejects(install({ ...options, update: true }), /40|pin/i);
  const source = path.join(options.root, 'source');
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"fixture-engine","version":"1.0.0","dependencies":{"missing":"99999.0.0"}}');
  await run('git', ['-C', source, 'add', 'package.json'], { env: options.environment });
  await run('git', ['-C', source, 'commit', '-m', 'broken-lock'], { env: options.environment });
  const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'], { env: options.environment })).stdout.trim();
  await fs.writeFile(manifest, JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit }));
  await assert.rejects(install({ ...options, update: true, environment: { ...options.environment, npm_config_offline: 'true' } }), /npm ci failed/i);
  assert.equal(await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8'), before);
});

test('transient staged-directory sharing failures retry without changing the current code or config', async t => {
  const options = await fixture(t);
  await install(options);
  const beforeConfig = await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8');
  const beforeCode = await fs.readFile(path.join(options.skillDir, 'engine/server.mjs'), 'utf8');
  const hook = path.join(options.root, 'transient-stage-lock.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';
    const rename = fs.rename;
    let failures = 0;
    fs.rename = async (from, to) => {
      if (process.platform === 'win32' && from.includes('.companion-stage-') && to === ${JSON.stringify(options.skillDir)} && failures < 2) {
        failures += 1;
        const error = new Error('scanner has the staged tree open');
        error.code = 'EPERM';
        throw error;
      }
      return rename(from, to);
    };`);

  const result = await run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--update'], { env: options.environment, timeout: 30_000 });
  assert.equal(JSON.parse(result.stdout).state, 'updated');
  assert.equal(await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8'), beforeConfig);
  assert.equal(await fs.readFile(path.join(options.skillDir, 'engine/server.mjs'), 'utf8'), beforeCode);
});

test('ordinary update does not rewrite an already-correct engineRoot configuration', async t => {
  const options = await fixture(t); await install(options);
  const beforeConfig = await fs.readFile(path.join(options.dataDir, 'config.json'));
  const hook = path.join(options.root, 'correct-config-no-rewrite.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.config-') && to.endsWith('config.json')) { const error = new Error('config rewrite unexpectedly attempted'); error.code = 'EPERM'; throw error; }
      return rename(from, to);
    };`);
  const result = await run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--update'], { env: options.environment, timeout: 30_000 });
  assert.equal(JSON.parse(result.stdout).state, 'updated');
  assert.deepEqual(await fs.readFile(path.join(options.dataDir, 'config.json')), beforeConfig);
});

test('permanent staged switch failure preserves byte-for-byte existing code and configuration', async t => {
  const options = await fixture(t); await install(options);
  const beforeCode = await fs.readFile(path.join(options.skillDir, 'engine/server.mjs'));
  const beforeConfig = await fs.readFile(path.join(options.dataDir, 'config.json'));
  const hook = path.join(options.root, 'permanent-switch-failure.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.companion-stage-') && to === ${JSON.stringify(options.skillDir)}) {
        const error = new Error('staged switch blocked'); error.code = 'EPERM'; throw error;
      }
      return rename(from, to);
    };`);
  await assert.rejects(run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--update'], { env: options.environment, timeout: 30_000 }), /staged switch blocked/);
  assert.deepEqual(await fs.readFile(path.join(options.skillDir, 'engine/server.mjs')), beforeCode);
  assert.deepEqual(await fs.readFile(path.join(options.dataDir, 'config.json')), beforeConfig);
  assert.equal((await install(options)).state, 'unchanged');
});

test('failed staging cleanup releases the lock while preserving the primary switch error and current install', async t => {
  const options = await fixture(t); await install(options);
  const beforeCode = await fs.readFile(path.join(options.skillDir, 'engine/server.mjs'));
  const beforeConfig = await fs.readFile(path.join(options.dataDir, 'config.json'));
  const hook = path.join(options.root, 'permanent-stage-cleanup-failure.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises'; import path from 'node:path';
    const rename = fs.rename; const rm = fs.rm;
    fs.rename = async (from, to) => {
      if (from.includes('.companion-stage-') && to === ${JSON.stringify(options.skillDir)}) {
        const error = new Error('staged switch blocked'); error.code = 'EPERM'; throw error;
      }
      return rename(from, to);
    };
    fs.rm = async (target, options) => {
      if (path.basename(String(target)).startsWith('.companion-stage-')) {
        const error = new Error('staging cleanup held'); error.code = 'EPERM'; throw error;
      }
      return rm(target, options);
    };`);
  const error = await run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--update'], { env: options.environment, timeout: 30_000 }).then(() => null, failure => failure);
  assert.ok(error, 'the permanent switch failure must reject');
  assert.match(error.stderr, /staged switch blocked/i);
  assert.match(error.stderr, /staging.*retained/i);
  assert.deepEqual(await fs.readFile(path.join(options.skillDir, 'engine/server.mjs')), beforeCode);
  assert.deepEqual(await fs.readFile(path.join(options.dataDir, 'config.json')), beforeConfig);
  assert.equal((await install(options)).state, 'unchanged');
});

test('fresh-install config failure quarantines the switched candidate away from the canonical path', async t => {
  const options = await fixture(t);
  const hook = path.join(options.root, 'fresh-config-failure.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.config-') && to.endsWith('config.json')) { const error = new Error('fresh config switch blocked'); error.code = 'EPERM'; throw error; }
      return rename(from, to);
    };`);
  const error = await run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir], { env: options.environment, timeout: 30_000 }).then(() => null, failure => failure);
  assert.ok(error, 'the injected fresh-install config failure must reject');
  assert.match(error.stderr, /fresh config switch blocked/i);
  const failedCode = /candidate is retained at (.+?)(?=;|\.\n)/.exec(error.stderr)?.[1];
  assert.ok(failedCode, 'error must name the quarantined candidate path');
  assert.ok((await fs.stat(failedCode)).isDirectory());
  await assert.rejects(fs.stat(options.skillDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(options.dataDir, 'config.json')), { code: 'ENOENT' });
});

test('quarantine failure reports only the live canonical candidate and real previous path', async t => {
  const options = await fixture(t); await install(options);
  await fs.unlink(path.join(options.dataDir, 'config.json'));
  const hook = path.join(options.root, 'quarantine-rollback-failure.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.config-') && to.endsWith('config.json')) { const error = new Error('config switch blocked'); error.code = 'EPERM'; throw error; }
      if (from === ${JSON.stringify(options.skillDir)} && to.includes('.failed-')) { const error = new Error('candidate quarantine blocked'); error.code = 'EPERM'; throw error; }
      return rename(from, to);
    };`);
  const error = await run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--update'], { env: options.environment, timeout: 30_000 }).then(() => null, failure => failure);
  assert.ok(error, 'the injected quarantine failure must reject');
  assert.ok(error.stderr.includes(`candidate remains at ${options.skillDir};`), 'error must name the exact live canonical candidate path');
  assert.doesNotMatch(error.stderr, /candidate is retained at .*\.failed-/i);
  const previous = /known-good previous code is retained at (.+?)(?=;|\.\n)/.exec(error.stderr)?.[1];
  assert.ok(previous, 'error must name the real previous-code path');
  assert.ok((await fs.stat(options.skillDir)).isDirectory());
  assert.ok((await fs.stat(previous)).isDirectory());
  await assert.rejects(fs.stat(path.join(options.dataDir, 'config.json')), { code: 'ENOENT' });
});

test('restore failure reports and retains both exact recovery directories', async t => {
  const options = await fixture(t); await install(options);
  await fs.unlink(path.join(options.dataDir, 'config.json'));
  const hook = path.join(options.root, 'restore-rollback-failure.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.config-') && to.endsWith('config.json')) { const error = new Error('config switch blocked'); error.code = 'EPERM'; throw error; }
      if (from.includes('.previous-') && to === ${JSON.stringify(options.skillDir)}) { const error = new Error('previous restoration blocked'); error.code = 'EPERM'; throw error; }
      return rename(from, to);
    };`);
  const error = await run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--update'], { env: options.environment, timeout: 30_000 }).then(() => null, failure => failure);
  assert.ok(error, 'the injected restore failure must reject');
  const failedCode = /candidate is retained at (.+?)(?=;|\.\n)/.exec(error.stderr)?.[1];
  const previous = /known-good previous code is retained at (.+?)(?=;|\.\n)/.exec(error.stderr)?.[1];
  assert.ok(failedCode, 'error must name the quarantined candidate path');
  assert.ok(previous, 'error must name the retained previous-code path');
  assert.ok((await fs.stat(failedCode)).isDirectory());
  assert.ok((await fs.stat(previous)).isDirectory());
  await assert.rejects(fs.stat(options.skillDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(options.dataDir, 'config.json')), { code: 'ENOENT' });
});

test('npm package symlinks escaping engine node_modules are rejected before installation', async t => {
  const options = await fixture(t); const source = path.join(options.root, 'source');
  await fs.mkdir(path.join(source, 'vendor/tool'), { recursive: true });
  await fs.writeFile(path.join(source, 'vendor/tool/package.json'), '{"name":"tool","version":"1.0.0","bin":{"fixture-tool":"cli.js"}}');
  await fs.writeFile(path.join(source, 'vendor/tool/cli.js'), '#!/usr/bin/env node\n');
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"fixture-engine","version":"1.0.0","dependencies":{"tool":"file:vendor/tool"}}');
  await fs.writeFile(path.join(source, 'package-lock.json'), JSON.stringify({ name: 'fixture-engine', version: '1.0.0', lockfileVersion: 3, packages: {
    '': { name: 'fixture-engine', version: '1.0.0', dependencies: { tool: 'file:vendor/tool' } },
    'node_modules/tool': { resolved: 'vendor/tool', link: true },
    'vendor/tool': { version: '1.0.0', bin: { 'fixture-tool': 'cli.js' } },
  } }));
  await run('git', ['-C', source, 'add', '.'], { env: options.environment });
  await run('git', ['-C', source, 'commit', '-m', 'bin-fixture'], { env: options.environment });
  const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'], { env: options.environment })).stdout.trim();
  await fs.writeFile(path.join(options.packageRoot, 'engine-lock.json'), JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit }));
  await assert.rejects(install(options), /unsafe symlink/i);
  await assert.rejects(fs.stat(options.skillDir), { code: 'ENOENT' });
});

test('npm bin shims whose canonical POSIX target remains in node_modules are owned', async t => {
  const options = await fixture(t); const source = path.join(options.root, 'source');
  const tool = path.join(options.root, 'tool'); await fs.mkdir(tool);
  await fs.writeFile(path.join(tool, 'package.json'), '{"name":"tool","version":"1.0.0","bin":{"fixture-tool":"cli.js"}}');
  await fs.writeFile(path.join(tool, 'cli.js'), '#!/usr/bin/env node\n');
  await run('npm', ['pack', '--pack-destination', source], { cwd: tool, env: options.environment });
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"fixture-engine","version":"1.0.0","dependencies":{"tool":"file:tool-1.0.0.tgz"}}');
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env: options.environment });
  await run('git', ['-C', source, 'add', '.'], { env: options.environment });
  await run('git', ['-C', source, 'commit', '-m', 'packed-bin-fixture'], { env: options.environment });
  const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'], { env: options.environment })).stdout.trim();
  await fs.writeFile(path.join(options.packageRoot, 'engine-lock.json'), JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit }));
  await install(options);
  const bin = path.join(options.skillDir, 'engine', 'node_modules', '.bin', 'fixture-tool');
  if (process.platform === 'win32') {
    for (const extension of ['.cmd', '.ps1']) assert.ok((await fs.lstat(bin + extension)).isFile(), `${extension} must be an owned ordinary file`);
  } else {
    assert.ok((await fs.lstat(bin)).isSymbolicLink());
    const target = await fs.realpath(bin);
    assert.equal(path.relative(path.join(options.skillDir, 'engine', 'node_modules'), target).split(path.sep).includes('..'), false);
  }
  assert.equal((await install(options)).state, 'unchanged');
});

test('real update and uninstall exclude a CLI start after the stopped probe and before filesystem switch', async t => {
  for (const operation of ['update', 'uninstall']) await t.test(operation, async t => {
    const options = await fixture(t); await install(options);
    const databasePath = path.join(options.dataDir, 'state.sqlite');
    const store = new Store(databasePath);
    const invitation = store.invite({ conversation_id: 'chat', request_id: 'seed', manual: true });
    store.accept(invitation.id);
    store.draw(invitation.id, { event_id: 'draw', question: '', spread_id: 'one', draws: [{ position: 0, card_id: 'fool', reversed: false }] });
    store.reveal(invitation.id, { event_id: 'reveal', positions: [0] });
    store.claimReading(invitation.id, { action_id: 'charge', model: 'synthetic' });
    store.close(); await fs.chmod(databasePath, 0o600);
    const marker = path.join(options.root, 'switch-paused'); const release = path.join(options.root, 'switch-release');
    const hook = path.join(options.root, 'pause-switch.mjs');
    await fs.writeFile(hook, `import fs from 'node:fs/promises';
      const rename=fs.rename;
      fs.rename=async(from,to)=>{
        if(from===${JSON.stringify(options.skillDir)}){
          await fs.writeFile(${JSON.stringify(marker)},'paused');
          for(let i=0;i<1000;i++){try{await fs.stat(${JSON.stringify(release)});break;}catch{await new Promise(r=>setTimeout(r,10));}}
        }
        return rename(from,to);
      };`);
    const installing = run(process.execPath, ['--import', hook, path.join(options.packageRoot, 'scripts/install.mjs'), '--data-dir', options.dataDir, '--skill-dir', options.skillDir, '--' + operation], { env: options.environment, timeout: 15000 }).then(result => ({ result }), error => ({ error }));
    let finished;
    try {
      await waitForFile(marker);
      await assert.rejects(run(process.execPath, [cliScript, 'serve', '--data-dir', options.dataDir], { env: options.environment, timeout: 700 }), /install.*lock|installation.*progress/i);
      const readOnly = new DatabaseSync(databasePath, { readOnly: true });
      try { assert.equal(readOnly.prepare('SELECT state FROM readings').get().state, 'running'); } finally { readOnly.close(); }
    } finally { await fs.writeFile(release, 'continue'); finished = await installing; }
    if (finished.error) throw finished.error;
    assert.equal(JSON.parse(finished.result.stdout).state, operation === 'update' ? 'updated' : 'uninstalled');
  });
});

test('a live authenticated CLI owner blocks both update and uninstall without replacing its code', async t => {
  const options = await fixture(t); await install(options);
  const cli = (...args) => run(process.execPath, [cliScript, ...args, '--data-dir', options.dataDir], { env: options.environment, timeout: 10000 });
  await cli('invite', '--conversation', 'chat', '--manual');
  try {
    const before = await fs.readFile(path.join(options.skillDir, 'engine/server.mjs'), 'utf8');
    for (const operation of ['update', 'uninstall']) await assert.rejects(install({ ...options, [operation]: true }), /Stop the owned service/);
    assert.equal(await fs.readFile(path.join(options.skillDir, 'engine/server.mjs'), 'utf8'), before);
  } finally { await cli('stop-service'); }
});

test('changed engine pin refuses a compatible authenticated orphan before switching code or config', async t => {
  const options = await fixture(t); const source = path.join(options.root, 'source');
  async function version(build) {
    await fs.writeFile(path.join(source, 'server.mjs'), `import http from 'node:http';
      http.createServer((req,res)=>{
        if(req.headers.authorization!=='Bearer '+process.env.COVE_TAROT_COMPANION_TOKEN){res.writeHead(403).end();return;}
        res.end(JSON.stringify({protocol:'cove-tarot-engine-v1',engine:'tarot',version:1,build:${JSON.stringify(build)}}));
      }).listen(Number(process.env.PORT),'127.0.0.1');`);
    await run('git', ['-C', source, 'add', 'server.mjs'], { env: options.environment });
    await run('git', ['-C', source, 'commit', '-m', 'synthetic-' + build], { env: options.environment });
    const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'], { env: options.environment })).stdout.trim();
    await fs.writeFile(path.join(options.packageRoot, 'engine-lock.json'), JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit }));
    return commit;
  }
  const commitA = await version('A'); await install(options);
  const reservation = http.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const enginePort = reservation.address().port; await new Promise(r => reservation.close(r));
  const config = await writeConfig(options.dataDir, { enginePort });
  const owner = new Engine({ root: config.engineRoot, port: enginePort, token: config.engineToken, environment: { HOME: options.root } });
  t.after(() => owner.close());
  await owner.start(); const pid = owner.pid;
  assert.equal((await install(options)).state, 'unchanged', 'no-op installation remains harmless while A runs');
  const code = await fs.readFile(path.join(config.engineRoot, 'server.mjs'), 'utf8');
  const configText = await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8');
  await fs.writeFile(path.join(options.dataDir, 'saved-record'), 'retain A data');
  const commitB = await version('B'); assert.notEqual(commitB, commitA);
  for (const operation of ['update', 'uninstall']) {
    await assert.rejects(install({ ...options, [operation]: true }), /engine port.*occupied/i);
    assert.equal(await fs.readFile(path.join(config.engineRoot, 'server.mjs'), 'utf8'), code);
    assert.equal(await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8'), configText);
    assert.equal(await fs.readFile(path.join(options.dataDir, 'saved-record'), 'utf8'), 'retain A data');
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal((await (await owner.request('/api/companion-health', { headers: { authorization: 'Bearer ' + config.engineToken } })).json()).build, 'A');
  }
  await owner.close();
  assert.equal((await install({ ...options, update: true })).commit, commitB);
  assert.equal(await fs.readFile(path.join(options.dataDir, 'config.json'), 'utf8'), configText);
  await owner.start();
  assert.equal((await (await owner.request('/api/companion-health', { headers: { authorization: 'Bearer ' + config.engineToken } })).json()).build, 'B');
});

test('foreign engine-port occupants block update and uninstall without being terminated', async t => {
  const options = await fixture(t); await install(options);
  const foreign = http.createServer((req, res) => res.end('foreign service'));
  await new Promise(r => foreign.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => foreign.close(r)));
  const port = foreign.address().port;
  await writeConfig(options.dataDir, { enginePort: port });
  for (const operation of ['update', 'uninstall']) await assert.rejects(install({ ...options, [operation]: true }), /engine port.*occupied/i);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign service');
  assert.equal((await install(options)).state, 'unchanged');
});
