import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalDraw, buildResult } from './result.mjs';

const BASE = '/companion/v1';
const pause = ms => new Promise(r => setTimeout(r, ms));
const fail = (status, message = 'Request rejected') => Object.assign(new Error(message), { status });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const scriptJSON = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
async function readBody(req, limit = 65536) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415);
  if (Number(req.headers['content-length']) > limit) throw fail(413);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413); chunks.push(chunk); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400);
    return body;
  } catch { throw fail(400); }
}

/** The fixed loopback listening socket is the exclusive owner lock. Bind it
 * BEFORE calling the Store factory, because opening Store performs recovery.
 * Do not change a live installation's configured port or open its DB in a CLI.
 */
export async function createService({ config, store: storeOrFactory, engine }) {
  let store; let ready = false; let closing = false; let closePromise; let finalizePromise; let adminShutdownPromise; let storeClosed = false;
  let origin;
  const workers = new Map(); const bindings = new Map(); const streams = new Set();
  const proxies = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.end(); return; }
      json(res, { error: 'Request rejected; check consent, state and local configuration.' }, error.status || 500);
    });
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.servicePort, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  try { store = typeof storeOrFactory === 'function' ? await storeOrFactory() : storeOrFactory; ready = true; }
  catch (error) { await new Promise(r => server.close(r)); throw error; }
  const service = { server, origin, close };
  return service;

  function guard(req, { allowInitializing = false } = {}) {
    if ((!ready || closing) && !allowInitializing) throw fail(503);
    if (!origin) throw fail(503);
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw fail(403);
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail(403);
    if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('#')) throw fail(400);
    if (req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) throw fail(403);
  }
  function binding(req, id, accepted = true) {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')));
    const value = bindings.get(cookies[`ctc_${id}`]);
    if (!value || value.id !== id || value.expires < Date.now() || (accepted && !value.accepted)) throw fail(403);
    return value;
  }
  function anyBinding(req) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [name] = part.trim().split('=');
      if (!name.startsWith('ctc_')) continue;
      try { return binding(req, name.slice(4)); } catch { /* another session's cookie */ }
    }
    throw fail(403);
  }
  function activeProxyBinding(req) {
    const id = req.headers['x-companion-session'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail(403);
    const value = binding(req, id);
    if (!['accepted', 'drawn', 'revealed'].includes(store.session(id).phase)) throw fail(403);
    return value;
  }
  function cancelSession(id) {
    for (const operation of [...workers.values(), ...proxies]) if (operation.sessionId === id) operation.controller.abort();
  }
  function csrf(req, value) {
    if (req.headers.origin !== origin || !equal(req.headers['x-companion-csrf'], value.csrf)) throw fail(403);
  }
  function admin(req) {
    if (!equal(req.headers.authorization, `Bearer ${config.adminToken}`)) throw fail(403);
  }
  async function handle(req, res) {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    const initializingHealth = req.method === 'GET' && req.url === `${BASE}/health`;
    guard(req, { allowInitializing: initializingHealth });
    let url; let pathname;
    try { url = new URL(req.url, origin); pathname = decodeURIComponent(url.pathname); } catch { throw fail(400); }
    if (pathname.split('/').some(part => part.startsWith('.')) || pathname.includes('\\') || pathname.includes('\0')) throw fail(404);
    if ([`${BASE}/health`, `${BASE}/invitations`, `${BASE}/events`, `${BASE}/claim`, `${BASE}/unknown`, `${BASE}/ack`, `${BASE}/stop-service`].includes(pathname) || pathname.startsWith(`${BASE}/results/`)) {
      admin(req);
      const command = pathname.slice(`${BASE}/`.length);
      if (req.method === 'GET') {
        if (command === 'health') return json(res, { protocol: 'cove-tarot-companion-v1', installation_id: config.installationId, pid: process.pid, ready: ready && !closing });
        if (command === 'events') return json(res, store.eventsPage(url.searchParams.get('conversation_id'), {
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
        }));
        if (command.startsWith('results/')) {
          const session = store.session(command.slice('results/'.length));
          if (session.conversation_id !== url.searchParams.get('conversation_id')) throw fail(404);
          return json(res, buildResult(session, await engine.catalog()));
        }
      } else if (req.method === 'POST') {
        const body = await readBody(req);
        if (command === 'invitations') return json(res, { ...store.invite(body), origin });
        if (command === 'claim') return json(res, store.claimDelivery(body));
        if (command === 'unknown') return json(res, store.markDeliveryUnknown(body));
        if (command === 'ack') return json(res, store.ack(body));
        if (command === 'stop-service') {
          try { await stopForAdmin(); }
          catch {
            return json(res, {
              stopped: false,
              state: 'running',
              error: 'Owned engine termination could not be verified.',
              recovery: 'Retry stop-service. If it still fails, stop the service from its known terminal or restart the computer before installation. Never kill a process guessed from a port.',
            }, 503);
          }
          res.once('finish', () => setImmediate(() => { void finalize().catch(() => {}); }));
          json(res, { stopped: true });
          return;
        }
      }
      throw fail(404);
    }
    let match = /^\/invite\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
    if (match && req.method === 'GET') {
      const id = match[1]; store.invitation(id);
      for (const [token, value] of bindings) if (value.expires < Date.now()) bindings.delete(token);
      if (bindings.size >= 2048) throw fail(429);
      const token = randomBytes(32).toString('hex'); const csrf_token = randomBytes(32).toString('hex');
      bindings.set(token, { id, csrf: csrf_token, accepted: false, expires: Date.now() + 86400000 });
      res.setHeader('set-cookie', `ctc_${id}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      const template = await fs.readFile(new URL('../public/invitation.html', import.meta.url), 'utf8');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(template.replace('INVITATION_CONFIG', scriptJSON({ id, csrf_token })));
    }
    match = new RegExp(`^${BASE}/invitations/([A-Za-z0-9_-]{1,128})/(accept|reject)$`).exec(pathname);
    if (match && req.method === 'POST') {
      const value = binding(req, match[1], false); csrf(req, value); await readBody(req);
      if (match[2] === 'reject') return json(res, store.reject(value.id));
      const session = store.accept(value.id); value.accepted = true;
      return json(res, { session, url: `/ritual/${session.id}` });
    }
    match = new RegExp(`^${BASE}/sessions/([A-Za-z0-9_-]{1,128})(?:/(draw|reveal|reading|return|stop|delete))?$`).exec(pathname);
    if (match) {
      const [, id, action] = match; const value = binding(req, id);
      if (req.method === 'GET') {
        if (!action) return json(res, { session: store.session(id), csrf_token: value.csrf });
        if (action === 'reading') return observe(req, res, id, store.reading(id, url.searchParams.get('attempt_id')).id);
      }
      if (req.method !== 'POST') throw fail(405);
      csrf(req, value); const body = await readBody(req);
      if (action === 'draw') { canonicalDraw(body, await engine.catalog()); return json(res, store.draw(id, body)); }
      if (action === 'reveal') return json(res, store.reveal(id, body));
      if (action === 'return') { const event = store.returnSession(id, body.revision); cancelSession(id); return json(res, event); }
      if (action === 'stop' || action === 'delete') {
        if (action === 'delete' && body.confirm !== true) throw fail(400);
        const session = store[action](id);
        cancelSession(id);
        return json(res, session);
      }
      if (action === 'reading') {
        const catalog = await engine.catalog();
        guard(req); // A catalog continuation must not claim/start work during close.
        const session = store.session(id);
        if (session.phase !== 'revealed') throw fail(409);
        const spread = catalog.spreads.find(item => item.id === session.spread_id);
        const messages = catalog.buildReadingMessages({ question: session.question, spread,
          placed: session.draws.map(draw => ({ card: catalog.deck.find(card => card.id === draw.card_id), slot: spread.slots[draw.position], reversed: draw.reversed })) });
        // No credential fingerprint or provider label enters persistent state.
        const { attempt, claimed } = store.claimReading(id, { action_id: body.action_id, model: body.model });
        if (claimed) {
          const controller = new AbortController();
          const worker = { controller, sessionId: id };
          workers.set(attempt.id, worker);
          worker.promise = readUpstream(id, attempt.id, { providerId: body.providerId, provider: body.provider, model: body.model,
            temperature: body.temperature, maxTokens: body.maxTokens, messages }, controller.signal).finally(() => workers.delete(attempt.id));
        }
        return observe(req, res, id, attempt.id);
      }
      throw fail(404);
    }
    if (pathname.startsWith('/api/')) {
      const value = activeProxyBinding(req);
      if (req.headers['x-tarot-request'] !== '1') throw fail(403);
      const get = pathname === '/api/dsh';
      if (!['/api/dsh', '/api/dsh/import', '/api/models', '/api/chat'].includes(pathname) || req.method !== (get ? 'GET' : 'POST')) throw fail(404);
      if (!get && req.headers.origin !== origin) throw fail(403);
      const operation = { sessionId: value.id, controller: new AbortController() };
      const abort = () => operation.controller.abort();
      operation.controller.signal.addEventListener('abort', () => res.destroy(), { once: true });
      res.once('close', abort); proxies.add(operation);
      try {
        operation.promise = (async () => {
          let body = get ? null : await readBody(req, 4 * 1024 * 1024);
          if (pathname === '/api/chat') {
            // Only the original photo identifier may bypass the durable read claim.
            const parts = body.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []);
            const dataUrl = parts?.find(part => part.type === 'image_url')?.image_url?.url;
            if (typeof dataUrl !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw fail(400);
            body = { ...body, messages: (await engine.catalog()).buildIdentifyMessages(dataUrl) };
          }
          // Consent may have been revoked while uploading or loading the catalog.
          operation.controller.signal.throwIfAborted(); activeProxyBinding(req);
          const response = await engine.request(pathname, { method: req.method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([operation.controller.signal, AbortSignal.timeout(125000)]) });
          if (!response.ok) { await response.body?.cancel(); throw fail(response.status); }
          res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
          let size = 0;
          for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024 || res.destroyed || res.writableLength > 262144) break; res.write(chunk); }
          return res.end();
        })();
        return await operation.promise;
      } finally {
        res.off('close', abort); proxies.delete(operation);
      }
    }
    match = /^\/ritual\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
    if (match && req.method === 'GET') {
      binding(req, match[1]); store.session(match[1]);
      const html = await staticFile('index.html');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const proxyBinding = `(()=>{const sessionId=${scriptJSON(match[1])};const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url||String(input),location.origin);if(url.origin===location.origin&&['/api/dsh','/api/dsh/import','/api/models','/api/chat'].includes(url.pathname)){const headers=new Headers(init?.headers||input?.headers);headers.set('X-Companion-Session',sessionId);return nativeFetch(input,{...init,headers});}return nativeFetch(input,init);};})();`;
      return res.end(html.toString('utf8').replace('<head>', `<head><base href="/"><script type="application/json" id="companion-config">${scriptJSON({ protocol: 'cove-tarot-companion-v1', sessionId: match[1], apiBase: BASE })}</script><script id="companion-proxy-binding">${proxyBinding}</script>`));
    }
    anyBinding(req);
    if (req.method !== 'GET' || !/^\/(?:js|css|data|fonts|vendor|assets)\/[A-Za-z0-9_./-]+$/.test(pathname)) throw fail(404);
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(pathname)];
    if (!mime) throw fail(404);
    const data = await staticFile(pathname.slice(1)); res.setHeader('content-type', mime); res.end(data);
  }
  async function staticFile(relative) {
    const root = await fs.realpath(path.join(engine.root, 'public'));
    let filename = root;
    try {
      for (const part of relative.split('/')) {
        if (!part || part.startsWith('.')) throw fail(404);
        filename = path.join(filename, part);
        if ((await fs.lstat(filename)).isSymbolicLink()) throw fail(404);
      }
      if (!(await fs.stat(filename)).isFile()) throw fail(404);
      return await fs.readFile(filename);
    } catch { throw fail(404); }
  }
  async function readUpstream(sessionId, attemptId, body, signal) {
    let state = 'unknown'; let errored = false; let done = false;
    try {
      const response = await engine.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(125000)]) });
      if (!response.ok) { state = 'failed'; await response.body?.cancel(); return; }
      const decoder = new TextDecoder(); let pending = ''; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { state = 'failed'; break; }
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
          if (line.length > 131072) throw fail(413);
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5).trim());
          if (event.t === 'delta') {
            if (typeof event.v !== 'string') throw fail(400);
            store.appendReading(sessionId, attemptId, event.v);
          } else if (event.t === 'error') { errored = true; state = 'failed'; }
          else if (event.t === 'done') { done = true; state = errored ? 'failed' : 'succeeded'; break; }
        }
        if (pending.length > 131072) throw fail(413);
        if (done) break;
      }
    } catch (error) { state = error.status ? 'failed' : 'unknown'; }
    finally {
      try { if (store.reading(sessionId, attemptId).state === 'running') store.finishReading(sessionId, attemptId, state); }
      catch { /* stopped/deleted records reject late writes */ }
    }
  }
  async function observe(req, res, sessionId, attemptId) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', 'x-companion-attempt': attemptId });
    streams.add(res); let offset = 0;
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      while (!res.destroyed && !closing) {
        const attempt = store.reading(sessionId, attemptId);
        if (res.writableLength > 262144) break;
        if (attempt.text.length > offset) { send({ t: 'delta', v: attempt.text.slice(offset) }); offset = attempt.text.length; }
        if (attempt.state !== 'running') {
          if (attempt.state !== 'succeeded') send({ t: 'error', v: `Reading ${attempt.state}; saved text is incomplete. Do not retry automatically.` });
          send({ t: 'done' }); break;
        }
        await pause(20);
      }
    } catch { /* deletion or a closing observer */ }
    finally { streams.delete(res); res.end(); }
  }
  async function quiesce() {
    const operations = [...workers.values(), ...proxies];
    for (const operation of operations) operation.controller.abort();
    for (const response of streams) response.end();
    await Promise.allSettled(operations.map(operation => operation.promise));
  }
  async function stopForAdmin() {
    if (adminShutdownPromise) return adminShutdownPromise;
    closing = true;
    const attempt = (async () => {
      await quiesce();
      await engine.close();
    })();
    adminShutdownPromise = attempt;
    try { await attempt; }
    catch (error) {
      if (adminShutdownPromise === attempt) adminShutdownPromise = null;
      closing = false;
      throw error;
    }
  }
  function finalize() {
    finalizePromise ??= (async () => {
      ready = false;
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
      if (!storeClosed) { storeClosed = true; store.close(); }
      bindings.clear();
    })();
    return finalizePromise;
  }
  function close() {
    closePromise ??= (async () => {
      closing = true;
      let failure;
      try {
        await quiesce();
        await engine.close();
      } catch (error) { failure = error; }
      try { await finalize(); }
      catch (error) { failure ??= error; }
      if (failure) throw failure;
    })();
    return closePromise;
  }
}
