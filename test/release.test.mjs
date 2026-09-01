import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { install } from '../scripts/install.mjs';

const scannerURL = new URL('../scripts/check-release.mjs', import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-synthetic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Cove Contributors'); git('config', 'user.email', 'contributors@users.noreply.github.com');
  await fs.writeFile(path.join(root, 'engine-lock.json'), JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit: 'a'.repeat(40) }));
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Synthetic fixture'); };
  commit();
  return { root, git, commit, write: (name, text) => fs.writeFile(path.join(root, name), text) };
}
async function scan(options) {
  assert.equal(await fs.stat(scannerURL).then(() => true, () => false), true, 'release scanner must exist');
  return (await import(scannerURL)).checkRelease(options);
}

test('clean exact public source and project metadata pass without exposing matches', async t => {
  const f = await fixture(t);
  const result = await scan({ cwd: f.root, expectedCommit: 'a'.repeat(40) });
  assert.deepEqual(result.findings, []); assert.equal(result.ok, true);
  assert.ok(result.commits >= 1); assert.ok(result.blobs >= 1);
});

test('tracked content detects synthetic credentials, private paths, terms and network addresses', async t => {
  const f = await fixture(t);
  const planted = ['sk-' + 'X9q2z'.repeat(9), '/' + 'Users/fictional-person/secret', 'Fictional' + 'PrivateMarker', '192.168.' + '52.17'];
  await f.write('notes.txt', planted.join('\n')); f.git('add', '.');
  const result = await scan({ cwd: f.root, privateTerms: [planted[2]] });
  assert.equal(result.ok, false);
  for (const rule of ['credential', 'private-path', 'private-term', 'private-network']) assert.ok(result.findings.some(f => f.rule === rule), rule);
  for (const secret of planted) assert.ok(!JSON.stringify(result).includes(secret), 'diagnostics must not repeat private values');
});

test('deleted historical leaks and nonproject commit metadata still block publication', async t => {
  const f = await fixture(t);
  await f.write('removed.txt', 'sk-' + 'Y8r3w'.repeat(9)); f.commit();
  await fs.unlink(path.join(f.root, 'removed.txt')); f.commit();
  f.git('config', 'user.email', 'fictional-author@example.invalid');
  await f.write('harmless.txt', 'public'); f.commit();
  const result = await scan({ cwd: f.root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(f => f.rule === 'credential' && f.location.startsWith('history:')));
  assert.ok(result.findings.some(f => f.rule === 'commit-identity'));
});

test('a different download source, floating ref, or unexpected exact pin blocks release', async t => {
  const f = await fixture(t);
  for (const lock of [{ repository: 'https://example.invalid/engine.git', commit: 'a'.repeat(40) }, { repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit: 'main' }, { repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit: 'b'.repeat(40) }]) {
    await f.write('engine-lock.json', JSON.stringify(lock));
    const result = await scan({ cwd: f.root, expectedCommit: 'a'.repeat(40) });
    assert.equal(result.ok, false); assert.ok(result.findings.some(f => f.rule === 'engine-lock'));
  }
});

test('tracked secret containers, symlinks and staged-only secrets cannot evade inspection', async t => {
  const f = await fixture(t);
  await f.write('.env.production', 'harmless fixture');
  await fs.symlink('engine-lock.json', path.join(f.root, 'linked')); f.git('add', '.');
  await f.write('index-only.txt', 'sk-' + 'Z7s4v'.repeat(9)); f.git('add', '.');
  await f.write('index-only.txt', 'working copy clean');
  const result = await scan({ cwd: f.root });
  for (const rule of ['private-file', 'symlink', 'credential']) assert.ok(result.findings.some(f => f.rule === rule), rule);
});

test('necessary exact public source URLs are narrowly exempt, not their account segment elsewhere', async t => {
  const f = await fixture(t);
  const source = JSON.parse(await fs.readFile(path.join(f.root, 'engine-lock.json'), 'utf8')).repository;
  const accountSegment = new URL(source).pathname.split('/')[1];
  await f.write('source.md', `[Upstream](${source.replace(/\.git$/, '')})`); f.git('add', '.');
  assert.equal((await scan({ cwd: f.root, privateTerms: [accountSegment] })).ok, true);
  await f.write('source.md', `${source}\n${accountSegment}`);
  assert.equal((await scan({ cwd: f.root, privateTerms: [accountSegment] })).ok, false);
  await f.write('source.md', source + '/private-suffix');
  assert.equal((await scan({ cwd: f.root, privateTerms: [accountSegment] })).ok, false);
});

test('credential assignments without a vendor prefix are detected while explicit synthetic examples are allowed', async t => {
  const f = await fixture(t);
  await f.write('settings.js', 'export const apiKey = "' + 'J8n4Q2x9v6R3p7T5'.repeat(2) + '";'); f.git('add', '.');
  assert.ok((await scan({ cwd: f.root })).findings.some(f => f.rule === 'credential'));
  await f.write('settings.js', 'export const apiKey = "synthetic-example-key";'); f.git('add', '.');
  assert.equal((await scan({ cwd: f.root })).ok, true);
});

test('a valid unstaged lock cannot mask an invalid staged release lock', async t => {
  const f = await fixture(t);
  const valid = await fs.readFile(path.join(f.root, 'engine-lock.json'), 'utf8');
  await f.write('engine-lock.json', JSON.stringify({ repository: 'https://example.invalid/unreviewed.git', commit: 'main' }));
  f.git('add', 'engine-lock.json');
  await f.write('engine-lock.json', valid);
  const result = await scan({ cwd: f.root, expectedCommit: 'a'.repeat(40) });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(f => f.rule === 'engine-lock' && f.location.startsWith('index:')));
});

test('a valid working and staged lock cannot mask an invalid HEAD lock, even with an empty history range', async t => {
  const f = await fixture(t);
  const valid = await fs.readFile(path.join(f.root, 'engine-lock.json'), 'utf8');
  await f.write('engine-lock.json', JSON.stringify({ repository: 'https://example.invalid/unreviewed.git', commit: 'main' })); f.commit();
  await f.write('engine-lock.json', valid); f.git('add', 'engine-lock.json');
  for (const base of [undefined, f.git('rev-parse', 'HEAD')]) {
    const result = await scan({ cwd: f.root, base, expectedCommit: 'a'.repeat(40) });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(f => f.rule === 'engine-lock' && (f.location.startsWith('history:') || f.location === 'HEAD:engine-lock')));
  }
});

test('expected pin applies to the staged release while legitimate historical versions remain valid', async t => {
  const f = await fixture(t);
  const valid = JSON.parse(await fs.readFile(path.join(f.root, 'engine-lock.json'), 'utf8'));
  await f.write('engine-lock.json', JSON.stringify({ ...valid, commit: 'b'.repeat(40) }));
  f.git('add', 'engine-lock.json');
  assert.equal((await scan({ cwd: f.root, expectedCommit: 'b'.repeat(40) })).ok, true, 'staging a new reviewed exact pin must not require rewriting HEAD');
  f.commit();
  assert.equal((await scan({ cwd: f.root, expectedCommit: 'b'.repeat(40) })).ok, true, 'older immutable pins must not equal the newest expected pin');
  await f.write('engine-lock.json', JSON.stringify(valid));
  assert.equal((await scan({ cwd: f.root })).ok, false, 'different valid working/index pins must not mask each other without an expected pin');
});

test('the engine lock must exist in the release index, not just as an untracked working file', async t => {
  const f = await fixture(t);
  f.git('rm', '--cached', 'engine-lock.json');
  assert.equal((await scan({ cwd: f.root })).ok, false);
});

test('a clean packaged install keeps native runtime files and executes its doctor command', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release package 占卜-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-global'),
    GIT_AUTHOR_NAME: 'Cove Contributors',
    GIT_AUTHOR_EMAIL: 'contributors@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Cove Contributors',
    GIT_COMMITTER_EMAIL: 'contributors@users.noreply.github.com'
  };
  const engine = path.join(root, 'fixture-engine');
  await fs.mkdir(engine);
  await run('git', ['init', '-q', engine], { env: environment });
  await fs.writeFile(path.join(engine, 'package.json'), '{"name":"fixture-engine","version":"1.0.0","type":"module"}');
  await fs.writeFile(path.join(engine, 'package-lock.json'), '{"name":"fixture-engine","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture-engine","version":"1.0.0"}}}');
  await fs.writeFile(path.join(engine, 'server.mjs'), 'process.exit(0);');
  await run('git', ['-C', engine, 'add', '.'], { env: environment });
  await run('git', ['-C', engine, 'commit', '-qm', 'Fixture engine'], { env: environment });
  const commit = (await run('git', ['-C', engine, 'rev-parse', 'HEAD'], { env: environment })).stdout.trim();

  const packageRoot = path.join(root, 'public package');
  await fs.mkdir(packageRoot);
  for (const relative of ['src', 'scripts', 'public', 'agents', 'references']) {
    await fs.cp(path.join(projectRoot, relative), path.join(packageRoot, relative), { recursive: true });
  }
  for (const relative of ['package.json', 'package-lock.json', 'SKILL.md', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await fs.copyFile(path.join(projectRoot, relative), path.join(packageRoot, relative));
  }
  await fs.writeFile(path.join(packageRoot, 'engine-lock.json'), JSON.stringify({ repository: 'https://github.com/moonlin1213/tarot-ritual.git', commit }) + '\n');
  await run('git', ['init', '-q', packageRoot], { env: environment });
  await run('git', ['-C', packageRoot, 'add', '.'], { env: environment });
  await run('git', ['-C', packageRoot, 'commit', '-qm', 'Public package fixture'], { env: environment });

  const packageScan = await scan({ cwd: packageRoot, expectedCommit: commit });
  assert.deepEqual(packageScan.findings, [], 'the packaged public surface must contain no host path or credential finding');
  assert.equal(packageScan.ok, true);

  Object.assign(environment, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${engine}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/moonlin1213/tarot-ritual.git'
  });
  const skillDir = path.join(root, 'installed skill 占卜');
  const dataDir = path.join(root, 'private data 占卜');
  await install({ packageRoot, skillDir, dataDir, environment });
  for (const relative of ['scripts/companion.mjs', 'src/platform.mjs', 'README.md', 'SKILL.md', 'engine-lock.json']) {
    assert.deepEqual(await fs.readFile(path.join(skillDir, relative)), await fs.readFile(path.join(packageRoot, relative)), relative);
  }
  const doctor = await run(process.execPath, [path.join(skillDir, 'scripts/companion.mjs'), 'doctor', '--help', '--data-dir', dataDir], { env: environment });
  assert.match(doctor.stdout, /doctor \| serve \| stop-service/);
  assert.equal(doctor.stderr, '');
});
