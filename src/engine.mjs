import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnOwned, stopOwnedChild } from './platform.mjs';

const ROUTES = new Set(['/api/dsh', '/api/dsh/import', '/api/models', '/api/chat', '/api/companion-health']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Owns only children launched here; an authenticated orphan may be reused but
 * is never terminated through a guessed PID or a port lookup. */
export class Engine {
  #child = null;
  #starting = null;
  #closing = null;
  #generation = 0;
  #catalog;
  #platform;
  #spawnImplementation;
  constructor({ root, executable = process.execPath, port, token, environment = process.env, platform = process.platform, spawnImplementation }) {
    if (!path.isAbsolute(root) || !path.isAbsolute(executable) || !Number.isInteger(port) || port < 1024 || port > 65535 || !token) throw new Error('Invalid fixed engine configuration');
    this.root = root; this.executable = executable; this.port = port; this.token = token;
    this.#platform = platform; this.#spawnImplementation = spawnImplementation;
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
  async start(signal) {
    signal?.throwIfAborted();
    if (this.#closing) throw new Error('Engine is closing');
    if (!this.#starting) {
      const startup = { generation: this.#generation, signals: [signal] };
      this.#starting = startup;
      startup.promise = this.#start(startup).finally(() => { if (this.#starting === startup) this.#starting = null; });
    } else this.#starting.signals.push(signal);
    await this.#starting.promise;
    signal?.throwIfAborted();
  }
  async #start(startup) {
    const check = () => {
      if (startup.generation !== this.#generation) throw new Error('Engine startup cancelled by close');
      // Coalesced callers retain independent cancellation: an active caller
      // still needs startup, but cancelled callers alone cannot launch a child.
      if (startup.signals.every(signal => signal?.aborted)) throw new DOMException('Engine startup aborted', 'AbortError');
    };
    const identified = await this.#identity(); check();
    if (identified) return;
    const occupied = await this.#occupied(); check();
    if (occupied) throw new Error('Engine port occupied by an unauthenticated service');
    const child = spawnOwned(this.executable, ['--use-env-proxy', 'server.mjs'], {
      cwd: this.root, env: this.environment, stdio: 'ignore', platform: this.#platform, spawnImplementation: this.#spawnImplementation,
    });
    this.#child = child;
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('exit', () => { failed = true; if (this.#child === child) this.#child = null; });
    try {
      for (let i = 0; i < 100 && !failed; i++) {
        const identified = await this.#identity(); check();
        if (identified) return;
        await delay(50); check();
      }
      throw new Error('Owned engine failed to start or authenticate');
    } catch (error) {
      // Startup cleanup must not call close(), which waits for this startup.
      await this.#stopChild(child);
      throw error;
    }
  }
  async request(route, options = {}) {
    if (!ROUTES.has(route)) throw new Error('Engine route is not allowed');
    await this.start(options.signal);
    return fetch(this.origin + route, { ...options, redirect: 'error', headers: {
      ...options.headers, host: `127.0.0.1:${this.port}`, origin: this.origin, 'x-tarot-request': '1',
    } });
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#generation++;
    this.#closing = (async () => {
      await this.#starting?.promise.catch(() => {});
      await this.#stopChild(this.#child);
    })().finally(() => { this.#closing = null; });
    return this.#closing;
  }
  async #stopChild(child) {
    await stopOwnedChild(child, { platform: this.#platform });
    if (this.#child === child) this.#child = null;
  }
}
