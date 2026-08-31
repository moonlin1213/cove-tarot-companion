import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Engine } from '../src/engine.mjs';
import { loadConfig, writeConfig, assertRuntime, secureFile } from '../src/config.mjs';

test('a missing engine executable rejects startup instead of leaving an unclosable child', async () => {
  const engine = new Engine({ root: os.tmpdir(), executable: path.join(os.tmpdir(), 'nonexistent-companion-executable'), port: 18641, token: 'synthetic' });
  const result = await Promise.race([engine.start().then(() => 'started', () => 'rejected'), new Promise(r => setTimeout(() => r('hung'), 500))]);
  assert.equal(result, 'rejected'); assert.equal(engine.pid, null);
});

test('engine identity probing rejects an oversized open response without unlimited buffering', async () => {
  const previous = globalThis.fetch; let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(5000))); }, cancel() { cancelled = true; } }));
  try {
    const engine = new Engine({ root: os.tmpdir(), executable: path.join(os.tmpdir(), 'nonexistent-companion-executable'), port: 18641, token: 'synthetic' });
    const result = await Promise.race([engine.start().then(() => 'started', () => 'rejected'), new Promise(r => setTimeout(() => r('hung'), 200))]);
    assert.equal(result, 'rejected'); assert.equal(cancelled, true);
  } finally { globalThis.fetch = previous; }
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-engine-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'server.mjs'), `
    import http from 'node:http';
    http.createServer((req,res)=>{
      if(req.headers.authorization !== 'Bearer '+process.env.COVE_TAROT_COMPANION_TOKEN){res.writeHead(403).end();return;}
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({protocol:'cove-tarot-engine-v1',engine:'tarot',version:1,proxy:process.execArgv.includes('--use-env-proxy')}));
    }).listen(Number(process.env.PORT),'127.0.0.1');
  `);
  const socket = http.createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const engine = new Engine({ root, executable: process.execPath, port, token: 'synthetic-engine-secret', environment: { HOME: root, TAROT_DSH_DIR: root } });
  t.after(() => engine.close());
  return { root, port, engine };
}

test('engine starts once on demand with proxy flag, closes only its child, and cold restarts', async t => {
  const { engine } = await fixture(t);
  assert.equal(engine.pid, null);
  await Promise.all([engine.start(), engine.start(), engine.start()]);
  const pid = engine.pid;
  assert.ok(pid > 0);
  const body = await (await engine.request('/api/companion-health', { headers: { authorization: 'Bearer synthetic-engine-secret' } })).json();
  assert.equal(body.proxy, true);
  await engine.close();
  assert.equal(engine.pid, null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await engine.start();
  assert.notEqual(engine.pid, pid);
});

test('occupied unauthenticated engine port is refused and never killed', async t => {
  const { port, engine } = await fixture(t);
  const other = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise(r => other.listen(port, '127.0.0.1', r));
  t.after(() => new Promise(r => other.close(r)));
  await assert.rejects(engine.start(), /occupied|identity/i);
  assert.equal(engine.pid, null);
  await engine.close();
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  await assert.rejects(engine.request('https://example.org/'), /route/i);
});

test('an authenticated orphan can be reused, but another owner never kills it by PID', async t => {
  const { root, port, engine } = await fixture(t);
  await engine.start(); const pid = engine.pid;
  const next = new Engine({ root, port, token: 'synthetic-engine-secret' });
  await next.start(); assert.equal(next.pid, null);
  await next.close();
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal((await next.request('/api/companion-health', { headers: { authorization: 'Bearer synthetic-engine-secret' } })).status, 200);
});

test('close drains held initial startup, rejects concurrent starts, and permits a later cold restart', async t => {
  const { engine } = await fixture(t);
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  let held = true; let closed = false;
  globalThis.fetch = async (...args) => {
    if (held && args[0] === engine.origin + '/api/companion-health') {
      held = false; entered.resolve(); await release.promise;
    }
    return originalFetch(...args);
  };
  const starting = engine.start().then(() => 'started', () => 'cancelled');
  let closing; let concurrent;
  try {
    await entered.promise;
    closing = engine.close().then(() => { closed = true; });
    concurrent = engine.start().then(() => 'started', () => 'cancelled');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(closed, false, 'close must settle the startup before releasing ownership');
    release.resolve(); await Promise.all([starting, concurrent, closing]);
    assert.equal(await starting, 'cancelled'); assert.equal(await concurrent, 'cancelled');
    assert.equal(engine.pid, null);
    await assert.rejects(originalFetch(engine.origin), /fetch failed/);
  } finally {
    release.resolve();
    await Promise.all([starting, concurrent, closing]);
    globalThis.fetch = originalFetch;
    // Also clean up the late child when this regression runs against old code.
    if (engine.pid) await engine.close();
  }
  await engine.start(); assert.ok(engine.pid > 0);
});

test('cancelled engine requests cannot launch a child before the initial probe', async t => {
  const { engine } = await fixture(t);
  await assert.rejects(engine.request('/api/dsh', { signal: AbortSignal.abort() }), /abort/i);
  assert.equal(engine.pid, null);
});

test('cancelled engine requests cannot launch a child during the initial probe', async t => {
  const { engine } = await fixture(t);
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const controller = new AbortController();
  globalThis.fetch = async (...args) => {
    if (args[0] === engine.origin + '/api/companion-health') { entered.resolve(); await release.promise; }
    return originalFetch(...args);
  };
  const requesting = engine.request('/api/dsh', { signal: controller.signal }).then(() => 'success', () => 'cancelled');
  try { await entered.promise; controller.abort(); }
  finally { release.resolve(); await requesting; globalThis.fetch = originalFetch; }
  assert.equal(await requesting, 'cancelled'); assert.equal(engine.pid, null);
  await assert.rejects(fetch(engine.origin), /fetch failed/);
});

test('one cancelled caller does not cancel a concurrent active engine request', async t => {
  const { engine } = await fixture(t);
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const controller = new AbortController();
  let held = true;
  globalThis.fetch = async (...args) => {
    if (held && args[0] === engine.origin + '/api/companion-health') { held = false; entered.resolve(); await release.promise; }
    return originalFetch(...args);
  };
  const first = engine.request('/api/dsh', { signal: controller.signal }).then(() => 'success', () => 'cancelled');
  let active;
  try {
    await entered.promise;
    active = engine.request('/api/companion-health', { headers: { authorization: 'Bearer synthetic-engine-secret' } });
    controller.abort(); release.resolve();
    assert.equal(await first, 'cancelled'); assert.equal((await active).status, 200);
    assert.ok(engine.pid > 0);
  } finally { release.resolve(); await Promise.allSettled([first, active]); globalThis.fetch = originalFetch; }
});

test('config enforces runtime floor, private regular secrets and stable installation values', async t => {
  const { root } = await fixture(t);
  assert.throws(() => assertRuntime('24.4.9'), /24.5/);
  assertRuntime('24.5.0');
  const dataDir = path.join(root, 'data');
  await writeConfig(dataDir, { engineRoot: root, servicePort: 18642, enginePort: 18643 });
  const first = await loadConfig(dataDir);
  await writeConfig(dataDir, { engineRoot: root });
  const second = await loadConfig(dataDir);
  assert.equal(first.adminToken, second.adminToken);
  assert.equal(first.origin, second.origin);
  assert.equal((await fs.stat(path.join(dataDir, 'config.json'))).mode & 0o077, 0);
  await fs.chmod(path.join(dataDir, 'config.json'), 0o644);
  await assert.rejects(loadConfig(dataDir), /private|permission/i);
  const link = path.join(root, 'secret-link');
  await fs.symlink(path.join(dataDir, 'config.json'), link);
  await assert.rejects(secureFile(link), /regular|symlink/i);
});
