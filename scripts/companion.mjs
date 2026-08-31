#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, defaultDataDir } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
import { createService } from '../src/server.mjs';

const BASE = '/companion/v1';
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function probeService(config) {
  let response;
  try { response = await fetch(config.origin + BASE + '/health', { headers: { authorization: `Bearer ${config.adminToken}` }, signal: AbortSignal.timeout(1500), redirect: 'error' }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new Error('Local service is occupied or cannot authenticate');
  }
  try {
    if (!response.ok) throw new Error();
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 4096) throw new Error();
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const health = JSON.parse(text);
    if (health.protocol !== 'cove-tarot-companion-v1' || health.installation_id !== config.installationId) throw new Error();
    return health;
  } catch { throw new Error('Local service identity does not match this installation'); }
}
async function ensureService(config) {
  if (await probeService(config)) return;
  // Competing children race only for the fixed socket. Losing children never
  // construct Store and cannot perform recovery over the winner's live work.
  const child = spawn(config.executable, [fileURLToPath(import.meta.url), 'serve', '--data-dir', config.dataDir], { detached: true, stdio: 'ignore', env: process.env });
  let failed = false; child.once('error', () => { failed = true; }); child.unref();
  for (let i = 0; i < 100 && !failed; i++) {
    await pause(50);
    try { if (await probeService(config)) return; }
    catch (error) { if (i > 10) throw error; }
  }
  throw new Error('Local service could not start; run serve to inspect the configuration');
}
async function call(config, route, body) {
  const response = await fetch(config.origin + BASE + route, { method: body === undefined ? 'GET' : 'POST', headers: {
    authorization: `Bearer ${config.adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Local request rejected (${response.status}); check conversation, consent and state`);
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 131072) throw new Error('Administrative response exceeds the 128 KiB limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function parseArguments(args) {
  const options = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const name = args[i].slice(2);
    if (['manual', 'update', 'uninstall'].includes(name)) options[name] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing --${name} value`); options[name] = args[++i]; }
  }
  return { options, positional };
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args[0] === 'help') return `Cove Tarot Companion — Node >=24.5.0
Usage: node scripts/companion.mjs COMMAND [--data-dir DIR]
  doctor | serve | stop-service
  invite --conversation ID [--manual] [--request ID]
  events --conversation ID [--cursor CURSOR] [--limit 1..100]
  result --session ID --conversation ID
  claim | unknown --event ID --conversation ID
  ack --event ID --conversation ID --message ACTUAL_HOST_MESSAGE_ID
Invitation acceptance is required before the engine starts. A claim is not a
host message: persist a real host message before ack. Never auto-retry unknown.
Credentials remain in the private data directory, never URLs or CLI output.`;
  const { options, positional } = parseArguments(args); const command = positional[0];
  if (!['doctor', 'serve', 'invite', 'events', 'result', 'claim', 'unknown', 'ack', 'stop-service'].includes(command) || positional.length !== 1) throw new Error('Use doctor, serve, invite, events, result, claim, unknown, ack or stop-service');
  if (Object.keys(options).some(key => !['data-dir', 'conversation', 'manual', 'request', 'session', 'event', 'message', 'cursor', 'limit'].includes(key))) throw new Error('Unknown option');
  const config = await loadConfig(options['data-dir'] || defaultDataDir());
  if (command === 'serve') {
    process.umask(0o077);
    const engine = new Engine({ root: config.engineRoot, executable: config.executable, port: config.enginePort, token: config.engineToken });
    const service = await createService({ config, engine, store: async () => {
      // Called only after acquiring the fixed-port owner lock.
      try {
        await fs.lstat(path.join(config.dataDir, '.install.lock'));
        throw new Error('Installation in progress; install lock prevents service startup');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          const stat = await fs.lstat(path.join(config.dataDir, 'state.sqlite' + suffix));
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe database file');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const { Store } = await import('../src/store.mjs');
      return new Store(path.join(config.dataDir, 'state.sqlite'));
    } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close(); });
    return { service: 'running', origin: service.origin };
  }
  if (command === 'doctor') {
    const health = await probeService(config);
    let engineInstalled = false;
    try { engineInstalled = (await fs.stat(path.join(config.engineRoot, 'server.mjs'))).isFile(); } catch {}
    return { node: process.versions.node, service: health ? 'running' : 'stopped', origin: config.origin, engineInstalled, dataDir: config.dataDir };
  }
  if (command === 'stop-service') {
    if (!await probeService(config)) return { stopped: true, alreadyStopped: true };
    return call(config, '/stop-service', {});
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.conversation || '')) throw new Error('--conversation requires an identifier');
  await ensureService(config);
  if (command === 'invite') {
    const result = await call(config, '/invitations', { conversation_id: options.conversation, request_id: options.request || randomUUID(), manual: !!options.manual });
    return { invitation_id: result.id, conversation_id: result.conversation_id, url: `${config.origin}/invite/${result.id}`, state: result.state };
  }
  if (command === 'events') {
    const query = new URLSearchParams({ conversation_id: options.conversation });
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', options.limit);
    return call(config, `/events?${query}`);
  }
  if (command === 'result') return call(config, `/results/${encodeURIComponent(options.session || '')}?conversation_id=${encodeURIComponent(options.conversation)}`);
  const body = { event_id: options.event, conversation_id: options.conversation };
  if (command === 'ack') body.message_id = options.message;
  return call(config, '/' + command, body);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => { process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result)) + '\n'); }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
