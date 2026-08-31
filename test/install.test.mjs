import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { install } from '../scripts/install.mjs';
import { loadConfig } from '../src/config.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-install-')));
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

test('npm generated executable symlinks are owned and verified without allowing private package symlinks', async t => {
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
  const result = await install(options);
  assert.equal(result.state, 'installed');
  assert.ok((await fs.lstat(path.join(options.skillDir, 'engine/node_modules/.bin/fixture-tool'))).isSymbolicLink());
  assert.equal((await install(options)).state, 'unchanged');
});
