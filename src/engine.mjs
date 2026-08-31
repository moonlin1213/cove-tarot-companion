import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROUTES = new Set(['/api/dsh', '/api/dsh/import', '/api/models', '/api/chat', '/api/companion-health']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Owns only children launched here; an authenticated orphan may be reused but
 * is never terminated through a guessed PID or a port lookup. */
export class Engine {
  #child = null;
  #starting = null;
  #catalog;
  constructor({ root, executable = process.execPath, port, token, environment = process.env }) {
    if (!path.isAbsolute(root) || !path.isAbsolute(executable) || !Number.isInteger(port) || port < 1024 || port > 65535 || !token) throw new Error('Invalid fixed engine configuration');
    this.root = root; this.executable = executable; this.port = port; this.token = token;
    this.environment = { ...environment, PORT: String(port), COVE_TAROT_COMPANION_TOKEN: token, TAROT_DSH_IMPORT: '0' };
    this.origin = `http://127.0.0.1:${port}`;
  }
  get pid() { return this.#child?.pid ?? null; }
  async catalog() {
    this.#catalog ??= Promise.all(['data/cards.js', 'data/spreads.js', 'js/reading.js'].map(file => import(pathToFileURL(path.join(this.root, 'public', file)).href)))
      .then(([cards, spreads, reading]) => ({ deck: cards.DECK, spreads: spreads.SPREADS, buildReadingMessages: reading.buildReadingMessages, buildIdentifyMessages: reading.buildIdentifyMessages }));
    return this.#catalog;
  }
  async #identity() {
    try {
      const response = await fetch(this.origin + '/api/companion-health', { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (!response.ok) return false;
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 4096) throw new Error('Oversized engine identity');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return body.protocol === 'cove-tarot-engine-v1' && body.engine === 'tarot' && body.version === 1;
    } catch { return false; }
  }
  async #occupied() {
    return new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: this.port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    });
  }
  async start() {
    if (this.#starting) return this.#starting;
    this.#starting = this.#start();
    try { await this.#starting; } finally { this.#starting = null; }
  }
  async #start() {
    if (await this.#identity()) return;
    if (await this.#occupied()) throw new Error('Engine port occupied by an unauthenticated service');
    const child = spawn(this.executable, ['--use-env-proxy', 'server.mjs'], { cwd: this.root, env: this.environment, stdio: 'ignore' });
    this.#child = child;
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('exit', () => { failed = true; if (this.#child === child) this.#child = null; });
    for (let i = 0; i < 100 && !failed; i++) {
      if (await this.#identity()) return;
      await delay(50);
    }
    await this.close();
    throw new Error('Owned engine failed to start or authenticate');
  }
  async request(route, options = {}) {
    if (!ROUTES.has(route)) throw new Error('Engine route is not allowed');
    await this.start();
    return fetch(this.origin + route, { ...options, redirect: 'error', headers: {
      ...options.headers, host: `127.0.0.1:${this.port}`, origin: this.origin, 'x-tarot-request': '1',
    } });
  }
  async close() {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    if (this.#child === child) this.#child = null;
  }
}
