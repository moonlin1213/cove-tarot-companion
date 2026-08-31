import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { createService } from '../src/server.mjs';
import { writeConfig } from '../src/config.mjs';

const run = promisify(execFile);
const engineRoot = process.env.TAROT_TEST_ENGINE_ROOT;
const enabled = process.env.TAROT_TEST_BROWSER === '1';
const cliPath = fileURLToPath(new URL('../scripts/companion.mjs', import.meta.url));
const ORIGINAL_TEXT = '### 综合信息\n这是隔离测试的原始综合。先做一个小样，不保证结果。\n### 建议\n写下今天能完成的一步。';

async function capture(page, filename) {
  if (!process.env.TAROT_TEST_ARTIFACT_DIR) return;
  await fs.mkdir(process.env.TAROT_TEST_ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.TAROT_TEST_ARTIFACT_DIR, filename), fullPage: true });
}

async function availablePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function setup(t, browserName, mode) {
  assert.ok(engineRoot, 'TAROT_TEST_ENGINE_ROOT must point to the actual pinned engine');
  const playwright = await import(process.env.TAROT_TEST_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.TAROT_TEST_PLAYWRIGHT_MODULE).href : 'playwright');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-browser-')));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ route: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic-model', object: 'model' }] }));
    assert.equal(req.url, '/v1/chat/completions');
    if (mode === 'failed') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Synthetic upstream unavailable' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ORIGINAL_TEXT } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = path.join(root, 'data');
  const config = await writeConfig(dataDir, { engineRoot: path.resolve(engineRoot), servicePort: await availablePort(), enginePort: await availablePort() });
  const environment = { ...process.env, HOME: root, TAROT_DSH_DIR: path.join(root, 'empty-dsh'), TAROT_DSH_IMPORT: '0', TAROT_DSH_OAUTH_REFRESH: '0', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
  const engine = new Engine({ root: config.engineRoot, executable: process.execPath, port: config.enginePort, token: config.engineToken, environment });
  const service = await createService({ config, engine, store: () => new Store(path.join(dataDir, 'state.sqlite')) });
  let browser;
  t.after(async () => {
    await browser?.close(); await service.close();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const executablePath = process.env[`TAROT_TEST_${browserName.toUpperCase()}_EXECUTABLE`];
  browser = await playwright[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(45000);
  // Never contact an external provider, even if a fixture accidentally changes.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  const apiRequests = [];
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) apiRequests.push({ route: new URL(req.url()).pathname, headers: req.headers() }); });
  const cli = async (...args) => JSON.parse((await run(process.execPath, [cliPath, ...args, '--data-dir', dataDir], { env: environment })).stdout);
  const conversation = `synthetic-${browserName}-${mode}`;
  const invitation = await cli('invite', '--conversation', conversation, '--manual');
  await page.goto(invitation.url);
  assert.equal(requests.length, 0, 'consent page must not call the upstream');
  await capture(page, `${browserName}-${mode}-invitation.png`);
  await page.getByRole('button', { name: '接受并打开' }).click();
  await page.waitForURL('**/ritual/*');
  await page.waitForFunction(() => window.__ritual?.cards.length === 78 && !document.querySelector('#beginBtn').disabled);
  t.diagnostic(`${browserName}/${mode}: original app initialized at /ritual/:id`);
  return { root, page, cli, conversation, invitation, browserErrors, apiRequests, requests, providerURL: `http://127.0.0.1:${upstream.address().port}/v1` };
}

async function configureProvider(f) {
  await f.page.locator('#providerOrb').click();
  await f.page.locator('#cpName').fill('Synthetic Provider');
  await f.page.locator('#cpKind').selectOption('openai');
  await f.page.locator('#cpBase').fill(f.providerURL);
  await f.page.locator('#cpKey').fill('synthetic-browser-key');
  await f.page.locator('#cpAdd').click();
  await f.page.waitForFunction(() => document.querySelector('#providerLabel').textContent.includes('synthetic-model'));
  await f.page.locator('#settingsClose').click();
  assert.ok(f.apiRequests.some(r => r.route === '/api/models' && r.headers['x-companion-session'] === f.invitation.invitation_id), 'real original settings request must carry the exact managed session');
}

async function drawOriginal(f) {
  await f.page.locator('#questionInput').fill('怎样开始一个新的个人项目？');
  await f.page.locator('label.mode-opt').filter({ hasText: '自行选阵' }).click();
  await f.page.locator('#beginBtn').click();
  await f.page.locator('.spread-item').filter({ hasText: '时间之流' }).click();
  await f.page.getByRole('button', { name: '命运代抽' }).click();
  // The original UI owns randomness, placement and batch reveal; observing its
  // existing public renderer objects does not populate Store or call handlers.
  await f.page.waitForFunction(() => window.__ritual.cards.filter(c => c.state === 'drawn').length >= 1);
  const initial = await f.page.evaluate(() => window.__ritual.cards.filter(c => c.state === 'drawn').map(c => ({ pending: c.pendingReveal, face: c.mesh.rotation.y })));
  assert.ok(initial.every(c => Math.abs(c.face - Math.PI) < 0.01), 'first selected card must stay face-down until the full batch');
  await f.page.waitForFunction(() => document.querySelector('#readingPanel').classList.contains('open'));
  const result = await f.cli('result', '--session', f.invitation.invitation_id, '--conversation', f.conversation);
  assert.equal(result.cards.length, 3); assert.equal(result.spread.zh, '时间之流');
  return result;
}

for (const browserName of ['chromium', 'webkit']) {
  for (const mode of ['succeeded', 'providerless', 'failed']) {
    test(`real ${browserName}: original UI ${mode}, saved refresh, return and persisted host receipt`, { skip: !enabled, timeout: 150000 }, async t => {
      const f = await setup(t, browserName, mode);
      if (mode !== 'providerless') await configureProvider(f);
      const drawn = await drawOriginal(f);
      if (mode === 'providerless') {
        assert.equal(drawn.reading_state, 'missing');
        assert.match(await f.page.locator('#readingStream').innerText(), /未连接|先在|服务|神谕/);
      } else {
        await f.page.waitForFunction(state => document.querySelector('#companionStatus').textContent.includes(state === 'succeeded' ? '已恢复原解读' : '原解读失败'), mode);
      }
      const before = await f.cli('result', '--session', f.invitation.invitation_id, '--conversation', f.conversation);
      assert.equal(before.reading_state, mode === 'providerless' ? 'missing' : mode);
      if (mode === 'succeeded') assert.equal(before.synthesis.text, ORIGINAL_TEXT);
      else assert.equal(before.synthesis.missing, true);
      await capture(f.page, `${browserName}-${mode}-reading.png`);
      const calls = f.requests.filter(r => r.route === '/v1/chat/completions');
      assert.equal(calls.length, mode === 'providerless' ? 0 : 1);
      if (calls.length) {
        assert.equal(calls[0].body.model, 'synthetic-model');
        assert.ok(calls[0].body.messages.some(m => typeof m.content === 'string' && m.content.includes('怎样开始一个新的个人项目')));
      }
      await f.page.reload();
      await f.page.waitForFunction(() => document.querySelector('#readingPanel')?.classList.contains('open'));
      const restored = await f.cli('result', '--session', f.invitation.invitation_id, '--conversation', f.conversation);
      assert.deepEqual(restored.cards, before.cards); assert.equal(restored.reading_id, before.reading_id); assert.deepEqual(restored.synthesis, before.synthesis);
      if (mode === 'succeeded') assert.match(await f.page.locator('#readingStream').innerText(), /不保证结果/);
      await f.page.getByRole('button', { name: '返回聊天', exact: true }).click();
      await f.page.waitForFunction(() => document.querySelector('#companionStatus').textContent.includes('已交回'));
      const envelope = await f.cli('events', '--conversation', f.conversation);
      assert.equal(envelope.events.length, 1); assert.equal(envelope.has_more, false);
      const event = envelope.events[0]; assert.equal(event.state, 'pending');
      const claim = await f.cli('claim', '--event', event.event_id, '--conversation', f.conversation); assert.equal(claim.claimed, true);
      const delivered = await f.cli('result', '--session', event.session_id, '--conversation', f.conversation);
      assert.equal(delivered.revision, event.revision);
      // A synthetic host persists an actual normal response before issuing ACK.
      const message = { id: `synthetic-message-${browserName}-${mode}`, conversation_id: f.conversation, event_id: event.event_id,
        role: 'assistant', content: mode === 'succeeded' ? '原解读建议先做一个小样。你愿意先试哪一步？' : '完整原解读暂时不可用。我们先从你想开始的项目选一个小动作。' };
      const ledger = path.join(f.root, 'host-message.json');
      const handle = await fs.open(ledger, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(message)); await handle.sync(); } finally { await handle.close(); }
      const persisted = JSON.parse(await fs.readFile(ledger, 'utf8'));
      const receipt = await f.cli('ack', '--event', event.event_id, '--conversation', f.conversation, '--message', persisted.id);
      assert.equal(receipt.state, 'sent'); assert.equal(receipt.message_id, persisted.id);
      await f.page.getByRole('button', { name: '返回聊天', exact: true }).click();
      await f.page.waitForFunction(() => document.querySelector('#companionStatus').textContent.includes('已送达'));
      const repeated = await f.cli('events', '--conversation', f.conversation);
      assert.equal(repeated.events.length, 1); assert.equal(repeated.events[0].event_id, event.event_id);
      assert.equal((await f.cli('claim', '--event', event.event_id, '--conversation', f.conversation)).claimed, false);
      assert.equal(f.requests.filter(r => r.route === '/v1/chat/completions').length, calls.length, 'refresh and repeated return must not rerun original reading');
      assert.deepEqual(f.browserErrors, []);
      t.diagnostic(`${browserName}/${mode}: 3-card original batch, refresh, one return event and persisted message ACK verified`);
    });
  }
}
