import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createService } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

const deck = [{ id: 'fool', zh: '愚者', en: 'The Fool' }];
const spreads = [{ id: 'one', zh: '单牌', en: 'One', count: 1, slots: [{ label: '当下', hint: 'Current' }] }];
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-http-')));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(path.join(publicDir, 'js'), { recursive: true });
  await fs.writeFile(path.join(publicDir, 'index.html'), '<html><head></head><body><script type="module" src="./js/main.js"></script></body></html>');
  await fs.writeFile(path.join(publicDir, 'js/main.js'), 'export const original = true;');
  await fs.writeFile(path.join(root, 'private-secret'), 'DO NOT SERVE');
  await fs.symlink(path.join(root, 'private-secret'), path.join(publicDir, 'js/escape.js'));
  const calls = [];
  let mode = 'success';
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/api/dsh') return res.end('{"providers":[]}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"t":"delta","v":"### 综合信息\\n原始解读。"}\n\n');
    await new Promise(r => setTimeout(r, 40));
    if (mode === 'error') res.write('data: {"t":"error","v":"synthetic-key-do-not-save"}\n\n');
    if (mode === 'oversize') res.write('data: ' + 'x'.repeat(140000));
    if (mode !== 'eof' && mode !== 'oversize') res.write('data: {"t":"done"}\n\n');
    res.end();
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  let starts = 0;
  const engine = { root, close: async () => {}, catalog: async () => ({ deck, spreads,
    buildReadingMessages: ({ question, placed }) => [{ role: 'system', content: 'Original builder' }, { role: 'user', content: question + ':' + placed[0].card.zh }],
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
  return { root, origin, service, admin, invite, post, accept, revealed, session, calls, reenter, restart, starts: () => starts, mode: value => { mode = value; } };
}

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
  assert.equal((await fetch(f.origin + '/api/dsh', { headers: { cookie: a.cookie, 'x-tarot-request': '1' } })).status, 200);
  assert.equal(f.calls.length, 1);
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
