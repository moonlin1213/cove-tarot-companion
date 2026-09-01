import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createService } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { stopOwnedChild } from '../src/platform.mjs';

const deck = [{ id: 'fool', zh: '愚者', en: 'The Fool' }];
const spreads = [{ id: 'one', zh: '单牌', en: 'One', count: 1, slots: [{ label: '当下', hint: 'Current' }] }];
async function fixture(t, engineFactory) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-http-')));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(path.join(publicDir, 'js'), { recursive: true });
  await fs.writeFile(path.join(publicDir, 'index.html'), '<html><head></head><body><script type="module" src="./js/main.js"></script></body></html>');
  await fs.writeFile(path.join(publicDir, 'js/main.js'), 'export const original = true;');
  await fs.writeFile(path.join(root, 'private-secret'), 'DO NOT SERVE');
  await fs.symlink(path.join(root, 'private-secret'), path.join(publicDir, 'js/escape.js'));
  const calls = [];
  const held = new Set(); let cancelled = 0;
  let mode = 'success';
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/api/dsh') return res.end('{"providers":[]}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"t":"delta","v":"### 综合信息\\n原始解读。"}\n\n');
    if (mode === 'hold') {
      held.add(res);
      await new Promise(resolve => res.once('close', () => { held.delete(res); cancelled++; resolve(); }));
      return;
    }
    await new Promise(r => setTimeout(r, 40));
    if (mode === 'error') res.write('data: {"t":"error","v":"synthetic-key-do-not-save"}\n\n');
    if (mode === 'oversize') res.write('data: ' + 'x'.repeat(140000));
    if (mode !== 'eof' && mode !== 'oversize') res.write('data: {"t":"done"}\n\n');
    res.end();
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  let starts = 0;
  const engine = engineFactory ? await engineFactory(root) : { root, close: async () => {}, catalog: async () => ({ deck, spreads,
    buildReadingMessages: ({ question, placed }) => [{ role: 'system', content: 'Original builder' }, { role: 'user', content: question + ':' + placed[0].card.zh }],
    buildIdentifyMessages: dataUrl => [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
  }), request: (route, options) => { starts++; return fetch(`http://127.0.0.1:${upstream.address().port}${route}`, options); } };
  const config = { servicePort: 0, adminToken: 'synthetic-admin-secret', dataDir: root, installationId: 'synthetic-installation' };
  let service = await createService({ config, engine, store: () => new Store(path.join(root, 'state.sqlite')) });
  const origin = service.origin;
  config.servicePort = Number(new URL(origin).port);
  const admin = (route, body) => fetch(origin + '/companion/v1/' + route, {
    method: body ? 'POST' : 'GET', headers: { connection: 'close', authorization: 'Bearer synthetic-admin-secret', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  t.after(async () => { await service.close(); await new Promise(r => upstream.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  async function invite(conversation = 'conversation-a') {
    const invitation = await (await admin('invitations', { conversation_id: conversation, request_id: crypto.randomUUID(), manual: true })).json();
    const page = await fetch(origin + '/invite/' + invitation.id, { headers: { connection: 'close' } });
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const initial = JSON.parse((await page.text()).match(/id="invitation-config">(.*?)<\/script>/s)[1]);
    return { id: invitation.id, cookie, csrf: initial.csrf_token };
  }
  async function post(client, suffix, body, headers = {}) {
    return fetch(origin + '/companion/v1/sessions/' + client.id + '/' + suffix, { method: 'POST', headers: {
      connection: 'close', origin, cookie: client.cookie, 'x-companion-csrf': client.csrf, 'content-type': 'application/json', ...headers,
    }, body: JSON.stringify(body) });
  }
  async function accept(client) {
    const response = await fetch(origin + '/companion/v1/invitations/' + client.id + '/accept', { method: 'POST', headers: {
      connection: 'close', origin, cookie: client.cookie, 'x-companion-csrf': client.csrf, 'content-type': 'application/json',
    }, body: '{}' });
    assert.equal(response.status, 200);
    return client;
  }
  async function revealed(client) {
    await accept(client);
    assert.equal((await post(client, 'draw', { event_id: 'draw', question: '问题', spread_id: 'one', draws: [{ position: 0, card_id: 'fool', reversed: false, zh: 'forged' }] })).status, 200);
    assert.equal((await post(client, 'reveal', { event_id: 'reveal', positions: [0] })).status, 200);
    return client;
  }
  const session = client => fetch(origin + '/companion/v1/sessions/' + client.id, { headers: { connection: 'close', cookie: client.cookie } }).then(r => r.json()).then(j => j.session);
  const reenter = async id => {
    const page = await fetch(origin + '/invite/' + id, { headers: { connection: 'close' } });
    const initial = JSON.parse((await page.text()).match(/id="invitation-config">(.*?)<\/script>/s)[1]);
    return accept({ id, cookie: page.headers.get('set-cookie').split(';')[0], csrf: initial.csrf_token });
  };
  const restart = async () => { await service.close(); service = await createService({ config, engine, store: () => new Store(path.join(root, 'state.sqlite')) }); };
  const proxy = (client, route, body, cookie = client.cookie) => fetch(origin + route, { method: body ? 'POST' : 'GET', headers: {
    connection: 'close', origin, cookie, 'x-tarot-request': '1', 'x-companion-session': client.id, ...(body ? { 'content-type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { root, origin, service, engine, admin, invite, post, accept, revealed, session, calls, reenter, restart, proxy,
    starts: () => starts, mode: value => { mode = value; }, cancelled: () => cancelled, release: () => { for (const response of held) response.end(); } };
}

test('authenticated stop reports an unverifiable retained-child exit, stays retryable, and never leaks or rejects unhandled', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-stop-failure-')));
  const retained = new EventEmitter();
  Object.assign(retained, { pid: 4242, exitCode: null, signalCode: null, kill: () => true });
  const engine = {
    root,
    close: () => stopOwnedChild(retained, { platform: 'linux', graceMs: 5 }),
  };
  const store = new Store(path.join(root, 'state.sqlite'));
  const service = await createService({
    config: { servicePort: 0, adminToken: 'synthetic-admin-secret', installationId: 'synthetic-installation' },
    store,
    engine,
  });
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const stop = () => fetch(service.origin + '/companion/v1/stop-service', {
    method: 'POST',
    headers: { connection: 'close', authorization: 'Bearer synthetic-admin-secret', 'content-type': 'application/json' },
    body: '{}',
  });
  t.after(async () => {
    process.off('unhandledRejection', onUnhandled);
    retained.signalCode ||= 'SIGKILL'; retained.emit('exit', null, retained.signalCode);
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(() => resolve()));
    try { store.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });

  const failed = await stop();
  const failureText = await failed.text();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(failed.status, 503);
  assert.ok(Buffer.byteLength(failureText) <= 1024);
  assert.match(failureText, /not.*verif|unverified|retry/i);
  assert.doesNotMatch(failureText, /synthetic-admin-secret|4242/);
  assert.deepEqual(unhandled, []);
  assert.equal((await fetch(service.origin + '/companion/v1/health', { headers: { authorization: 'Bearer synthetic-admin-secret' } })).status, 200,
    'a failed admin shutdown must remain available for a documented retry');

  retained.signalCode = 'SIGKILL'; retained.emit('exit', null, retained.signalCode);
  const retried = await stop();
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { stopped: true });
});

test('programmatic close finalizes the HTTP owner and store even when engine close rejects', async t => {
  let storeClosed = 0;
  const store = { close: () => { storeClosed += 1; } };
  const service = await createService({
    config: { servicePort: 0, adminToken: 'synthetic-admin-secret', installationId: 'synthetic-installation' },
    store,
    engine: { close: async () => { throw new Error('synthetic engine shutdown failure'); } },
  });
  t.after(async () => {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(() => resolve()));
  });
  await assert.rejects(service.close(), /synthetic engine shutdown failure/);
  assert.equal(storeClosed, 1);
  await assert.rejects(fetch(service.origin), /fetch failed/);
});

test('normal service close drains accepted original proxies before releasing engine ownership', async t => {
  for (const phase of ['initial-probe', 'owned-request']) await t.test(phase, async t => {
    const f = await fixture(t, async root => {
      await fs.writeFile(path.join(root, 'server.mjs'), `import http from 'node:http';
        http.createServer((req,res)=>res.end(JSON.stringify({protocol:'cove-tarot-engine-v1',engine:'tarot',version:1})))
          .listen(Number(process.env.PORT),'127.0.0.1');`);
      const reservation = http.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
      const port = reservation.address().port; await new Promise(r => reservation.close(r));
      return new Engine({ root, port, token: 'synthetic-token', environment: { HOME: root } });
    });
    const client = await f.accept(await f.invite());
    if (phase === 'owned-request') await f.engine.start();
    const pid = f.engine.pid;
    const originalFetch = globalThis.fetch;
    const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    const request = f.engine.request.bind(f.engine); let operation;
    f.engine.request = (...args) => (operation = request(...args));
    const route = phase === 'initial-probe' ? '/api/companion-health' : '/api/dsh';
    let held = true; let closed = false;
    globalThis.fetch = async (...args) => {
      if (held && args[0] === f.engine.origin + route) { held = false; entered.resolve(); await release.promise; }
      return originalFetch(...args);
    };
    const proxy = f.proxy(client, '/api/dsh').then(response => response.text(), () => 'cancelled').catch(() => 'cancelled');
    let closing;
    try {
      await entered.promise;
      closing = f.service.close().then(() => { closed = true; });
      await new Promise(r => setTimeout(r, 25));
      assert.equal(closed, false, 'service must drain even a proxy whose response is already destroyed');
      release.resolve(); await Promise.all([proxy, closing]); await Promise.allSettled([operation]);
      assert.equal(f.engine.pid, null);
      if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await assert.rejects(originalFetch(f.engine.origin), /fetch failed/);
      await assert.rejects(originalFetch(f.origin), /fetch failed/);
    } finally {
      release.resolve(); await Promise.all([proxy, closing]); await Promise.allSettled([operation]); globalThis.fetch = originalFetch;
      if (closed && f.engine.pid) await f.engine.close();
    }
  });
});

test('normal service close drains a reading catalog continuation without claiming work', async t => {
  const f = await fixture(t); const client = await f.revealed(await f.invite());
  const catalog = f.engine.catalog;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  f.engine.catalog = async () => { entered.resolve(); await release.promise; return catalog(); };
  const reading = f.post(client, 'reading', { action_id: 'closing-read', model: 'synthetic' });
  let closing;
  try {
    await entered.promise; closing = f.service.close();
    await new Promise(r => setTimeout(r, 25)); release.resolve();
    const response = await reading; await response.text(); await closing;
    assert.equal(response.status, 503);
    assert.equal(f.starts(), 0, 'no paid worker may begin after close starts');
    const stored = new Store(path.join(f.root, 'state.sqlite'));
    try { assert.equal(stored.session(client.id).reading, null); } finally { stored.close(); }
  } finally { release.resolve(); await Promise.allSettled([reading, closing]); }
});

test('consent, exact origin/host, CSRF, scoped cookies and static containment protect records', async t => {
  const f = await fixture(t);
  const a = await f.invite(); const b = await f.invite('conversation-b');
  assert.equal(f.starts(), 0);
  assert.equal((await f.post(a, 'stop', {})).status, 403);
  await f.accept(a); await f.accept(b);
  assert.equal(f.starts(), 0);
  assert.equal((await f.post(a, 'stop', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.post(a, 'stop', {}, { 'x-companion-csrf': 'bad' })).status, 403);
  assert.equal((await fetch(f.origin + '/companion/v1/sessions/' + a.id, { headers: { cookie: b.cookie } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(f.origin + '/companion/v1/sessions/' + a.id, { headers: { cookie: a.cookie, host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.session(a)).conversation_id, 'conversation-a');
  const html = await (await fetch(f.origin + '/ritual/' + a.id, { headers: { cookie: a.cookie } })).text();
  assert.match(html, /<base href="\/">/);
  assert.match(html, /companion-config/);
  assert.equal((await fetch(f.origin + '/js/main.js', { headers: { cookie: a.cookie } })).status, 200);
  for (const route of ['/js/escape.js', '/.git/config', '/config.json', '/js/%2e%2e/%2e%2e/private-secret']) assert.notEqual((await fetch(f.origin + route, { headers: { cookie: a.cookie } })).status, 200);
  assert.equal((await f.post(a, 'draw', { x: 'x'.repeat(70000) })).status, 413);
  assert.equal((await fetch(f.origin + '/api/dsh')).status, 403);
  assert.equal((await f.proxy(a, '/api/dsh')).status, 200);
  assert.equal(f.calls.length, 1);
});

test('managed page binds original fetch routes to its own session, without rewriting other fetches', async t => {
  const f = await fixture(t); const a = await f.accept(await f.invite());
  const html = await (await fetch(f.origin + '/ritual/' + a.id, { headers: { cookie: a.cookie } })).text();
  const script = html.match(/<script id="companion-proxy-binding">(.*?)<\/script>/s)?.[1];
  assert.ok(script, 'managed page must bind original absolute API routes to its session');
  const calls = [];
  const context = { window: { fetch: (...args) => { calls.push(args); return Promise.resolve('ok'); } }, location: { origin: f.origin }, URL, Headers };
  vm.runInNewContext(script, context);
  await context.window.fetch('/api/models', { method: 'POST', headers: { 'X-Tarot-Request': '1' }, body: 'original-body' });
  assert.equal(new Headers(calls[0][1].headers).get('X-Companion-Session'), a.id);
  assert.equal(calls[0][1].body, 'original-body');
  await context.window.fetch('https://example.invalid/api/models', { headers: { test: 'original' } });
  assert.equal(new Headers(calls[1][1].headers).get('X-Companion-Session'), null);
});

test('terminal cookies cannot restart original proxy work even alongside an active session cookie', async t => {
  const f = await fixture(t); const active = await f.accept(await f.invite('active'));
  for (const action of ['stop', 'delete', 'return']) {
    const terminal = await f.revealed(await f.invite('terminal-' + action));
    const body = action === 'return' ? { revision: (await f.session(terminal)).revision } : action === 'delete' ? { confirm: true } : {};
    assert.equal((await f.post(terminal, action, body)).status, 200);
    const jar = active.cookie + '; ' + terminal.cookie;
    const starts = f.starts();
    for (const [route, data] of [['/api/dsh', null], ['/api/dsh/import', { consent: true }], ['/api/models', { model: 'synthetic' }], ['/api/chat', { model: 'synthetic', messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }]]) {
      assert.equal((await f.proxy(terminal, route, data, jar)).status, 403);
    }
    assert.equal(f.starts(), starts); assert.equal((await f.session(terminal)).phase, action === 'return' ? 'returned' : action === 'stop' ? 'stopped' : 'deleted');
    if (action === 'stop') assert.equal((await f.post(terminal, 'return', { revision: (await f.session(terminal)).revision })).status, 200);
  }
  assert.equal((await f.proxy(active, '/api/dsh')).status, 200);
});

test('stop and delete cancel session-owned in-flight original photo requests and observers', async t => {
  const f = await fixture(t);
  for (const action of ['stop', 'delete']) {
    const a = await f.accept(await f.invite()); f.mode('hold');
    const response = await f.proxy(a, '/api/chat', { model: 'synthetic', messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
    const cancelled = f.cancelled();
    try {
      await f.post(a, action, action === 'delete' ? { confirm: true } : {});
      const outcome = await Promise.race([response.text().then(() => 'closed', () => 'closed'), new Promise(r => setTimeout(() => r('open'), 200))]);
      assert.equal(outcome, 'closed');
      for (let i = 0; i < 20 && f.cancelled() === cancelled; i++) await new Promise(r => setTimeout(r, 10));
      assert.ok(f.cancelled() > cancelled);
    } finally { f.release(); }
  }
});

test('HTTP event pages are bounded and losslessly traverse sent, unknown and pending events', async t => {
  const f = await fixture(t); const expected = [];
  for (let i = 0; i < 7; i++) {
    const a = await f.revealed(await f.invite('paged'));
    const event = await (await f.post(a, 'return', { revision: (await f.session(a)).revision })).json(); expected.push(event.event_id);
    const ref = { event_id: event.event_id, conversation_id: 'paged' };
    if (i < 2) await f.admin('claim', ref);
    if (i === 0) await f.admin('ack', { ...ref, message_id: 'real-message' });
    if (i === 1) await f.admin('unknown', ref);
  }
  let cursor; const seen = []; const states = [];
  do {
    const response = await f.admin('events?conversation_id=paged&limit=3' + (cursor ? '&cursor=' + cursor : ''));
    const text = await response.text(); assert.ok(Buffer.byteLength(text) < 65536);
    const page = JSON.parse(text); assert.ok(page.events.length <= 3);
    seen.push(...page.events.map(event => event.event_id)); states.push(...page.events.map(event => event.state));
    cursor = page.next_cursor; if (!page.has_more) break;
  } while (true);
  assert.deepEqual(seen, expected); assert.deepEqual(states.slice(0, 3), ['sent', 'unknown', 'pending']);
  assert.equal((await f.admin('events?conversation_id=paged&limit=101')).status, 400);
});

test('reading claims precede upstream, canonical builder wins, disconnect and replay never recharge', async t => {
  const f = await fixture(t); const a = await f.revealed(await f.invite());
  const body = { action_id: 'same', provider: { kind: 'openai', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'synthetic-key-do-not-save' }, model: 'test-model', messages: [{ content: 'forged' }] };
  const first = await f.post(a, 'reading', body);
  await first.body.cancel();
  const second = await f.post(a, 'reading', body); const stream = await second.text();
  assert.match(stream, /"t":"done"/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.messages[1].content, '问题:愚者');
  assert.equal(f.calls[0].body.provider.apiKey, 'synthetic-key-do-not-save');
  const saved = await f.session(a);
  assert.equal(saved.reading.state, 'succeeded');
  assert.equal(saved.reading.text, '### 综合信息\n原始解读。');
  assert.ok(!JSON.stringify(saved).includes('synthetic-key'));
  assert.ok(!(await fs.readFile(path.join(f.root, 'state.sqlite-wal'))).includes(Buffer.from('synthetic-key')));
  const observed = await fetch(f.origin + '/companion/v1/sessions/' + a.id + '/reading?attempt_id=' + saved.reading.id, { headers: { cookie: a.cookie } });
  assert.match(await observed.text(), /原始解读/);
  assert.equal(f.calls.length, 1);
});

test('error, EOF and oversized streams preserve partial facts without false success or leaked errors', async t => {
  const f = await fixture(t);
  for (const [mode, want] of [['error', 'failed'], ['eof', 'unknown'], ['oversize', 'failed']]) {
    const a = await f.revealed(await f.invite()); f.mode(mode);
    const response = await f.post(a, 'reading', { action_id: 'read', model: 'test' });
    const text = await response.text();
    assert.equal((await f.session(a)).reading.state, want);
    assert.match(text, /"t":"error"/);
    assert.ok(!text.includes('synthetic-key'));
  }
});

test('return is conversation scoped and requires claim plus actual host-message acknowledgement', async t => {
  const f = await fixture(t); const a = await f.revealed(await f.invite());
  const session = await f.session(a);
  const event = await (await f.post(a, 'return', { revision: session.revision })).json();
  assert.equal(event.state, 'pending');
  assert.equal((await f.post(a, 'return', { revision: session.revision })).status, 200);
  assert.equal((await f.admin(`results/${a.id}?conversation_id=wrong`)).status, 404);
  const result = await (await f.admin(`results/${a.id}?conversation_id=conversation-a`)).json();
  assert.equal(result.cards[0].zh, '愚者'); assert.equal(f.starts(), 0);
  const ref = { event_id: event.event_id, conversation_id: 'conversation-a' };
  assert.equal((await f.admin('ack', { ...ref, message_id: 'actual-message' })).status, 409);
  assert.equal((await (await f.admin('claim', ref)).json()).claimed, true);
  assert.equal((await (await f.admin('claim', ref)).json()).claimed, false);
  assert.equal((await f.admin('unknown', ref)).status, 200);
  assert.equal((await (await f.admin('ack', { ...ref, message_id: 'actual-message' })).json()).state, 'sent');
});

test('occupied service socket prevents Store recovery and accepted invitation reentry preserves records', async t => {
  const f = await fixture(t); const a = await f.revealed(await f.invite());
  let opened = false;
  await assert.rejects(createService({ config: { servicePort: Number(new URL(f.origin).port) }, engine: {}, store: () => { opened = true; } }), /EADDRINUSE/);
  assert.equal(opened, false);
  const page = await fetch(f.origin + '/invite/' + a.id);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const initial = JSON.parse((await page.text()).match(/id="invitation-config">(.*?)<\/script>/s)[1]);
  const reentry = { id: a.id, cookie, csrf: initial.csrf_token };
  await f.accept(reentry);
  assert.equal((await f.session(reentry)).phase, 'revealed');
});

test('service restart preserves accepted completed records and uncertain host claims without new calls', async t => {
  const f = await fixture(t); const a = await f.revealed(await f.invite());
  await (await f.post(a, 'reading', { action_id: 'saved', model: 'test' })).text();
  const session = await f.session(a);
  const event = await (await f.post(a, 'return', { revision: session.revision })).json();
  const ref = { event_id: event.event_id, conversation_id: 'conversation-a' };
  await f.admin('claim', ref);
  await f.restart();
  assert.equal((await fetch(f.origin + '/companion/v1/sessions/' + a.id, { headers: { cookie: a.cookie } })).status, 403);
  const restored = await f.reenter(a.id);
  assert.equal((await f.session(restored)).reading.state, 'succeeded');
  assert.equal((await (await f.admin('claim', ref)).json()).event.state, 'unknown');
  assert.equal((await (await f.admin('claim', ref)).json()).claimed, false);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.admin('ack', { ...ref, message_id: 'actual-persisted-message' })).status, 200);
});

test('failed service initialization releases the exclusive socket before any replacement owner', async t => {
  const f = await fixture(t);
  await f.service.close();
  await assert.rejects(createService({ config: { servicePort: Number(new URL(f.origin).port) }, engine: {}, store: () => { throw new Error('synthetic initializer failure'); } }), /initializer/);
  await f.restart();
  assert.equal((await f.admin('health')).status, 200);
});

test('installed original engine imports its canonical prompt builder and streams a synthetic custom provider', { skip: !process.env.TAROT_TEST_ENGINE_ROOT }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-original-')));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"### 综合信息\\n原文。"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const reservation = http.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const enginePort = reservation.address().port; await new Promise(r => reservation.close(r));
  const engine = new Engine({ root: path.resolve(process.env.TAROT_TEST_ENGINE_ROOT), port: enginePort, token: 'synthetic-token', environment: { ...process.env, HOME: root, TAROT_DSH_DIR: path.join(root, 'empty-dsh'), TAROT_DSH_OAUTH_REFRESH: '0', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
  const store = new Store(path.join(root, 'state.sqlite'));
  const service = await createService({ config: { servicePort: 0, adminToken: 'synthetic-admin' }, store, engine });
  t.after(async () => { await service.close(); await new Promise(r => upstream.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const invitation = store.invite({ conversation_id: 'chat', request_id: 'request', manual: true });
  const page = await fetch(service.origin + '/invite/' + invitation.id);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const config = JSON.parse((await page.text()).match(/id="invitation-config">(.*?)<\/script>/s)[1]);
  const headers = { cookie, origin: service.origin, 'content-type': 'application/json', 'x-companion-csrf': config.csrf_token };
  assert.equal(engine.pid, null);
  assert.equal((await fetch(service.origin + '/companion/v1/invitations/' + invitation.id + '/accept', { method: 'POST', headers, body: '{}' })).status, 200);
  const catalog = await engine.catalog(); const spread = catalog.spreads.find(item => item.count === 1);
  const post = (action, body) => fetch(service.origin + '/companion/v1/sessions/' + invitation.id + '/' + action, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('draw', { event_id: 'draw', question: '测试问题', spread_id: spread.id, draws: [{ position: 0, card_id: catalog.deck[0].id, reversed: true }] })).status, 200);
  assert.equal((await post('reveal', { event_id: 'reveal', positions: [0] })).status, 200);
  const read = await post('reading', { action_id: 'action', model: 'vendor/token-model', provider: { kind: 'openai', baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'synthetic-custom-key' } });
  assert.match(await read.text(), /原文/);
  assert.equal(store.session(invitation.id).reading.state, 'succeeded');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, 'Bearer synthetic-custom-key');
  assert.equal(requests[0].body.model, 'vendor/token-model');
  assert.match(requests[0].body.messages[0].content, /深谙韦特塔罗/);
  assert.match(requests[0].body.messages[1].content, /测试问题/);
  assert.match(requests[0].body.messages[1].content, /【逆位】/);
  await assert.rejects(fs.stat(path.join(root, 'empty-dsh')), { code: 'ENOENT' });
});
