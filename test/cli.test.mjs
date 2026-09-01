import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { createService } from '../src/server.mjs';
import { applyPrivateUmask, assertPrivateDatabaseFiles, ensurePrivateDirectory, removeWithRetry, securePrivateFile } from '../src/platform.mjs';
import { probeService, ensureService, main } from '../scripts/companion.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/companion.mjs', import.meta.url));

async function broadenPrivateFile(filename) {
  if (process.platform !== 'win32') return fs.chmod(filename, 0o644);
  const { runWindowsPowerShell } = await import('./windows-powershell.mjs');
  const program = String.raw`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:COVE_TAROT_TEST_ACL_PATH
$sid = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:COVE_TAROT_TEST_ACL_PATH -AclObject $acl
`;
  await runWindowsPowerShell(program, { ...process.env, COVE_TAROT_TEST_ACL_PATH: filename });
}

test('private umask applies only to POSIX processes', () => {
  if (process.platform === 'win32') {
    assert.doesNotThrow(() => applyPrivateUmask());
    return;
  }
  const original = process.umask();
  try {
    process.umask(0o022);
    applyPrivateUmask({ platform: 'win32' });
    assert.equal(process.umask(), 0o022);
    applyPrivateUmask({ platform: 'linux' });
    assert.equal(process.umask(), 0o077);
  } finally { process.umask(original); }
});

test('database privacy checks every existing SQLite, WAL and SHM file', async t => {
  const dataDir = await ensurePrivateDirectory(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-db-privacy-'))));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  for (const suffix of ['', '-wal', '-shm']) {
    const filename = path.join(dataDir, 'state.sqlite' + suffix);
    await fs.writeFile(filename, suffix || 'sqlite');
    await securePrivateFile(filename);
  }
  await assertPrivateDatabaseFiles(dataDir);
  await broadenPrivateFile(path.join(dataDir, 'state.sqlite-wal'));
  await assert.rejects(assertPrivateDatabaseFiles(dataDir), /private|owner|permission|acl|unsafe/i);
});
test('detached service launch preserves Unicode arguments and uses the owned hidden shell-free boundary', async () => {
  const config = {
    executable: process.execPath,
    dataDir: path.join(os.tmpdir(), 'Tarot Companion 中文'),
  };
  const calls = [];
  const child = new EventEmitter(); child.unref = () => {};
  let probes = 0;
  await ensureService(config, {
    platform: 'win32',
    probe: async () => (++probes === 1 ? null : { protocol: 'cove-tarot-companion-v1' }),
    spawnImplementation: (...args) => { calls.push(args); return child; },
  });
  assert.deepEqual(calls, [[process.execPath, [script, 'serve', '--data-dir', config.dataDir], {
    detached: true, stdio: 'ignore', env: process.env, shell: false, windowsHide: true,
  }]]);
});
test('service readiness polling accepts an injected pause without changing its probe contract', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  const pauses = []; let probes = 0;
  await ensureService({ executable: process.execPath, dataDir: '/synthetic' }, {
    probe: async () => (++probes === 1 ? null : { ready: true }),
    spawnImplementation: () => child,
    pauseImplementation: async milliseconds => { pauses.push(milliseconds); },
  });
  assert.deepEqual(pauses, [50]);
  assert.equal(probes, 2);
});
test('Windows service startup waits thirty seconds for its authenticated initializing owner', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  let elapsed = 0; let probes = 0; let spawns = 0;
  await ensureService({ executable: process.execPath, dataDir: '/synthetic' }, {
    platform: 'win32',
    clock: () => elapsed,
    pauseImplementation: async milliseconds => { elapsed += milliseconds; },
    probe: async () => {
      probes++;
      return { ready: probes > 1 && elapsed >= 30_000 };
    },
    spawnImplementation: () => { spawns++; return child; },
  });
  assert.equal(elapsed, 30_000);
  assert.equal(probes, 601);
  assert.equal(spawns, 0);
});
test('service readiness exhaustion is bounded at thirty seconds on Windows and five elsewhere', async () => {
  for (const [platform, expectedElapsed, expectedProbes] of [['win32', 30_000, 601], ['linux', 5_000, 101]]) {
    const child = new EventEmitter(); child.unref = () => {};
    let elapsed = 0; let probes = 0;
    await assert.rejects(ensureService({ executable: process.execPath, dataDir: '/synthetic' }, {
      platform,
      clock: () => elapsed,
      pauseImplementation: async milliseconds => { elapsed += milliseconds; },
      probe: async () => { probes++; return { ready: false }; },
      spawnImplementation: () => child,
    }), /could not start/);
    assert.equal(elapsed, expectedElapsed, platform);
    assert.equal(probes, expectedProbes, platform);
  }
});
test('service startup waits beyond the former identity grace for its authenticated initializing owner', async () => {
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const servicePort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const config = {
    executable: process.execPath,
    dataDir: path.join(os.tmpdir(), 'synthetic-companion-data'),
    servicePort,
    origin: `http://127.0.0.1:${servicePort}`,
    adminToken: 'synthetic-admin',
    installationId: 'synthetic-installation',
  };
  let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve; });
  let releaseResolve; const release = new Promise(resolve => { releaseResolve = resolve; });
  const child = new EventEmitter(); child.unref = () => {};
  let servicePromise; let service; let timer;
  try {
    const waiting = ensureService(config, { spawnImplementation: () => {
      servicePromise = createService({ config, engine: { close: async () => {} }, store: async () => {
        enteredResolve(); await release; return { close() {} };
      } });
      return child;
    } });
    await entered;
    const started = Date.now();
    timer = setTimeout(releaseResolve, 700);
    await waiting;
    assert.ok(Date.now() - started >= 650, 'startup must still be waiting after the former 550 ms grace');
    service = await servicePromise;
    assert.equal((await probeService(config)).ready, true);
  } finally {
    clearTimeout(timer); releaseResolve();
    try { service ??= await servicePromise; } catch {}
    await service?.close();
  }
});
test('service startup fails on the first genuine identity mismatch after spawning', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  let probes = 0; let spawns = 0;
  await assert.rejects(ensureService({ executable: process.execPath, dataDir: '/synthetic' }, {
    probe: async () => {
      probes++;
      if (probes === 1) return null;
      throw new Error('Local service identity does not match this installation');
    },
    spawnImplementation: () => { spawns++; return child; },
  }), /identity does not match/);
  assert.equal(spawns, 1);
  assert.equal(probes, 2);
});
test('service identity probing cancels oversized streaming replies without buffering indefinitely', async () => {
  const previous = globalThis.fetch; let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(5000))); }, cancel() { cancelled = true; } }));
  try {
    const outcome = await Promise.race([
      probeService({ origin: 'http://127.0.0.1:18642', adminToken: 'synthetic', installationId: 'synthetic' }).then(() => 'accepted', () => 'rejected'),
      new Promise(r => setTimeout(() => r('unbounded'), 150)),
    ]);
    assert.equal(outcome, 'rejected'); assert.equal(cancelled, true);
  } finally { globalThis.fetch = previous; }
});
test('CLI and installer help exit successfully without creating data or starting services', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-help-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'not-created');
  for (const name of ['companion.mjs', 'install.mjs']) {
    const result = await run(process.execPath, [fileURLToPath(new URL('../scripts/' + name, import.meta.url)), '--help', '--data-dir', dataDir], { env: { ...process.env, HOME: root } });
    assert.match(result.stdout, /--data-dir/); assert.equal(result.stderr, '');
    await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
  }
});

test('malformed private config never quotes a synthetic credential in CLI or update errors', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-malformed-config-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'); await writeConfig(dataDir, { engineRoot: root });
  const syntheticSecret = 'syntheticSECRET';
  await fs.writeFile(path.join(dataDir, 'config.json'), syntheticSecret);
  let failure;
  try { await run(process.execPath, [script, 'doctor', '--data-dir', dataDir], { env: { ...process.env, HOME: root } }); } catch (error) { failure = error; }
  assert.ok(failure); assert.equal(failure.code, 1);
  assert.equal(failure.stdout, ''); assert.ok(!failure.stderr.includes(syntheticSecret));
  assert.match(failure.stderr, /Invalid private configuration/);
  await assert.rejects(writeConfig(dataDir, { engineRoot: root }), error => !error.message.includes(syntheticSecret) && /Invalid private configuration/.test(error.message));
});

test('administrative CLI replies are byte bounded and oversized open bodies are cancelled', { timeout: 60_000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-admin-body-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await writeConfig(path.join(root, 'data'), { engineRoot: root });
  const previous = globalThis.fetch; let cancelled = false; let status = 200; let bodyEntered;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/health')) return Response.json({ protocol: 'cove-tarot-companion-v1', installation_id: config.installationId });
    bodyEntered();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(131073)); }, cancel() { cancelled = true; } }), { status });
  };
  try {
    for (status of [200, 403]) {
      cancelled = false; let releaseBody;
      const entered = new Promise(resolve => { releaseBody = resolve; }); bodyEntered = releaseBody;
      const operation = main(['events', '--conversation', 'chat', '--data-dir', config.dataDir]).then(() => 'accepted', () => 'rejected');
      assert.equal(await Promise.race([entered.then(() => 'entered'), operation]), 'entered');
      const result = await Promise.race([operation, new Promise(r => setTimeout(() => r('unbounded'), 200))]);
      assert.equal(result, 'rejected'); assert.equal(cancelled, true);
    }
  } finally { globalThis.fetch = previous; }
});

test('signal shutdown catches close rejection and emits bounded non-secret recovery guidance', async () => {
  const { registerShutdownSignals } = await import('../scripts/companion.mjs');
  assert.equal(typeof registerShutdownSignals, 'function', 'the CLI must expose the signal shutdown registration used by serve');
  const processObject = new EventEmitter();
  let stderr = '';
  Object.assign(processObject, { stderr: { write: value => { stderr += value; } }, exitCode: undefined });
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    registerShutdownSignals({ close: async () => { throw new Error('synthetic-private-shutdown-detail'); } }, { processObject });
    processObject.emit('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(processObject.exitCode, 1);
    assert.ok(Buffer.byteLength(stderr) <= 1024);
    assert.match(stderr, /shutdown.*not.*verified|stop-service.*retry/i);
    assert.doesNotMatch(stderr, /synthetic-private-shutdown-detail/);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion CLI 中文 空格-')));
  const socket = http.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const servicePort = socket.address().port; await new Promise(r => socket.close(r));
  const config = await writeConfig(path.join(root, 'data'), { engineRoot: root, servicePort, enginePort: servicePort === 65535 ? 18643 : servicePort + 1 });
  const env = { ...process.env, HOME: root, TAROT_DSH_DIR: root };
  const cli = (...args) => run(process.execPath, [script, ...args, '--data-dir', config.dataDir], { env, timeout: process.platform === 'win32' ? 60_000 : 15_000 });
  t.after(async () => {
    await cli('stop-service');
    if (process.platform === 'win32') await removeWithRetry(root, { recursive: true, force: true, timeout: 5_000, maxAttempts: 50, retryDelay: 100 });
    else await fs.rm(root, { recursive: true, force: true });
  });
  return { root, config, cli };
}

test('spawned CLI doctor is lazy; concurrent invites own one authenticated service; output contains no admin secret', async t => {
  const { cli, config } = await fixture(t);
  const doctor = JSON.parse((await cli('doctor')).stdout);
  assert.equal(doctor.service, 'stopped');
  const results = await Promise.all([cli('invite', '--conversation', 'chat-a', '--manual'), cli('invite', '--conversation', 'chat-b', '--manual')]);
  for (const result of results) {
    const invitation = JSON.parse(result.stdout); assert.match(invitation.url, /\/invite\//);
    assert.ok(!result.stdout.includes(config.adminToken)); assert.ok(!result.stderr.includes(config.adminToken));
    assert.ok(!result.stdout.includes(config.engineToken)); assert.ok(!result.stderr.includes(config.engineToken));
  }
  const runningResult = await cli('doctor');
  assert.equal(JSON.parse(runningResult.stdout).service, 'running');
  const eventsResult = await cli('events', '--conversation', 'chat-a', '--limit', '2');
  assert.deepEqual(JSON.parse(eventsResult.stdout).events, []);
  const stopResult = await cli('stop-service'); assert.equal(JSON.parse(stopResult.stdout).stopped, true);
  for (const result of [runningResult, eventsResult, stopResult]) {
    assert.ok(!result.stdout.includes(config.adminToken)); assert.ok(!result.stderr.includes(config.adminToken));
    assert.ok(!result.stdout.includes(config.engineToken)); assert.ok(!result.stderr.includes(config.engineToken));
  }
});

test('serve refuses a database with broadened native permissions without exposing credentials', async t => {
  const { cli, config } = await fixture(t);
  const databasePath = path.join(config.dataDir, 'state.sqlite');
  const store = new Store(databasePath); store.close();
  await securePrivateFile(databasePath);
  await broadenPrivateFile(databasePath);
  let failure;
  try { await cli('serve'); } catch (error) { failure = error; }
  assert.ok(failure); assert.equal(failure.code, 1);
  assert.match(failure.stderr, /private|owner|permission|acl|unsafe|database/i);
  for (const secret of [config.adminToken, config.engineToken]) {
    assert.ok(!failure.stdout.includes(secret)); assert.ok(!failure.stderr.includes(secret));
  }
});

test('an occupied wrong-identity service cannot cause CLI to recover a running database', async t => {
  const { cli, config } = await fixture(t);
  const db = new Store(path.join(config.dataDir, 'state.sqlite'));
  const invitation = db.invite({ conversation_id: 'chat', request_id: 'request', manual: true }); db.accept(invitation.id);
  db.draw(invitation.id, { event_id: 'draw', question: '', spread_id: 'one', draws: [{ position: 0, card_id: 'fool', reversed: false }] });
  db.reveal(invitation.id, { event_id: 'reveal', positions: [0] });
  db.claimReading(invitation.id, { action_id: 'charge', model: 'test' });
  const other = http.createServer((req, res) => res.end('{"protocol":"wrong"}'));
  await new Promise(r => other.listen(config.servicePort, '127.0.0.1', r));
  try {
    await assert.rejects(cli('invite', '--conversation', 'chat', '--manual'), /occupied|identity|authenticate/i);
    assert.equal(db.session(invitation.id).reading.state, 'running');
  } finally {
    db.close();
    await new Promise((resolve, reject) => other.close(error => error ? reject(error) : resolve()));
  }
});

test('spawned CLI events preserves the paginated envelope and follows explicit cursors without loss', async t => {
  const { cli, config } = await fixture(t);
  const databasePath = path.join(config.dataDir, 'state.sqlite');
  const store = new Store(databasePath); const expected = [];
  for (let i = 0; i < 5; i++) {
    const invitation = store.invite({ conversation_id: 'paged', request_id: 'page-' + i, manual: true });
    store.accept(invitation.id); store.stop(invitation.id);
    expected.push(store.returnSession(invitation.id, store.session(invitation.id).revision).event_id);
  }
  store.close(); await securePrivateFile(databasePath);
  let cursor; const seen = [];
  do {
    const args = ['events', '--conversation', 'paged', '--limit', '2'];
    if (cursor) args.push('--cursor', cursor);
    const page = JSON.parse((await cli(...args)).stdout);
    assert.ok(page.events.length <= 2); assert.equal(typeof page.has_more, 'boolean');
    seen.push(...page.events.map(event => event.event_id)); cursor = page.next_cursor;
    if (!page.has_more) break;
  } while (true);
  assert.deepEqual(seen, expected);
  await assert.rejects(cli('events', '--conversation', 'paged', '--limit', '101'), /400/);
});
