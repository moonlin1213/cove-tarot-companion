import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const scannerURL = new URL('../scripts/check-release.mjs', import.meta.url);
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
