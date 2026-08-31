import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { probeService } from '../scripts/companion.mjs';

const run = promisify(execFile);
const script = new URL('../scripts/companion.mjs', import.meta.url).pathname;
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
    const result = await run(process.execPath, [new URL('../scripts/' + name, import.meta.url).pathname, '--help', '--data-dir', dataDir], { env: { ...process.env, HOME: root } });
    assert.match(result.stdout, /--data-dir/); assert.equal(result.stderr, '');
    await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
  }
});
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-cli-')));
  const socket = http.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const servicePort = socket.address().port; await new Promise(r => socket.close(r));
  const config = await writeConfig(path.join(root, 'data'), { engineRoot: root, servicePort, enginePort: servicePort === 65535 ? 18643 : servicePort + 1 });
  const env = { ...process.env, HOME: root, TAROT_DSH_DIR: root };
  const cli = (...args) => run(process.execPath, [script, ...args, '--data-dir', config.dataDir], { env, timeout: 15000 });
  t.after(async () => { try { await cli('stop-service'); } catch {} await fs.rm(root, { recursive: true, force: true }); });
  return { root, config, cli };
}

test('spawned CLI doctor is lazy; concurrent invites own one authenticated service; output contains no admin secret', async t => {
  const { cli, config } = await fixture(t);
  const doctor = JSON.parse((await cli('doctor')).stdout);
  assert.equal(doctor.service, 'stopped');
  const results = await Promise.all([cli('invite', '--conversation', 'chat-a', '--manual'), cli('invite', '--conversation', 'chat-b', '--manual')]);
  for (const result of results) {
    const invitation = JSON.parse(result.stdout); assert.match(invitation.url, /\/invite\//);
    assert.ok(!result.stdout.includes(config.adminToken));
  }
  const running = JSON.parse((await cli('doctor')).stdout); assert.equal(running.service, 'running');
  assert.equal(JSON.parse((await cli('events', '--conversation', 'chat-a')).stdout).length, 0);
  assert.equal(JSON.parse((await cli('stop-service')).stdout).stopped, true);
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
  t.after(() => { db.close(); return new Promise(r => other.close(r)); });
  await assert.rejects(cli('invite', '--conversation', 'chat', '--manual'), /occupied|identity|authenticate/i);
  assert.equal(db.session(invitation.id).reading.state, 'running');
});
