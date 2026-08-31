import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

const DAY = 86_400_000;
const TERMINAL = new Set(['returned', 'stopped', 'deleted']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function id(value, name = 'id') {
  if (typeof value !== 'string' || !ID.test(value)) fail(`invalid ${name}`, 400);
  return value;
}
function text(value, max, name) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`invalid ${name}`, 400);
  return value;
}
function display(value, name) {
  text(value, 160, name);
  if (!value.trim() || /[\u0000-\u001f\u007f]|:\/\/|www\.|\b(?:bearer|api[_-]?key|token|password)\b/i.test(value)) fail(`invalid ${name}`, 400);
  if (name === 'source' && !/^[\p{L}\p{N} ._()·+-]+$/u.test(value)) fail('invalid source', 400);
  return value;
}
function safeSource(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(k => k !== 'display')) fail('invalid source', 400);
  return source.display === undefined ? {} : { display: display(source.display, 'source') };
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** One owning service must hold its data-directory lock before opening Store.
 * Startup deliberately marks interrupted attempts/deliveries unknown; a second
 * concurrent owner must not use a constructor as a read-only polling interface.
 */
export class Store {
  #db;
  #clock;
  constructor(dbPath, { clock = Date.now } = {}) {
    this.#clock = clock;
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
        manual INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, rejected_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY REFERENCES invitations(id), conversation_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL,
        question TEXT NOT NULL DEFAULT '', spread_id TEXT, draws TEXT NOT NULL DEFAULT '[]', reading_id TEXT
      );
      CREATE TABLE IF NOT EXISTS receipts (
        session_id TEXT NOT NULL REFERENCES sessions(id), event_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(session_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS readings (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), action_id TEXT NOT NULL,
        model TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
        UNIQUE(session_id,action_id)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        conversation_id TEXT NOT NULL, revision INTEGER NOT NULL, requested_revision INTEGER NOT NULL,
        state TEXT NOT NULL, message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_conversation_sequence ON deliveries(conversation_id,sequence);`);
    this.#tx(() => {
      this.#db.exec(`UPDATE sessions SET revision=revision+1 WHERE id IN
        (SELECT session_id FROM readings WHERE state='running');
        UPDATE readings SET state='unknown' WHERE state='running';
        UPDATE deliveries SET state='unknown' WHERE state='claimed';`);
    });
  }
  #tx(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) fail('invalid clock', 400);
    return now;
  }
  #row(sessionId) {
    id(sessionId);
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!row) fail('session requires accepted consent', 404);
    return row;
  }
  #active(row) { if (TERMINAL.has(row.phase)) fail(`session phase ${row.phase} is read-only`); }
  #bump(sessionId) { this.#db.prepare('UPDATE sessions SET revision=revision+1 WHERE id=?').run(sessionId); }
  invitation(invitationId) {
    const row = this.#db.prepare('SELECT * FROM invitations WHERE id=?').get(id(invitationId));
    if (!row) fail('invitation not found', 404);
    return { ...row, manual: Boolean(row.manual) };
  }
  invite({ conversation_id, request_id, manual = false }) {
    id(conversation_id, 'conversation_id'); id(request_id, 'request_id');
    if (typeof manual !== 'boolean') fail('invalid manual', 400);
    return this.#tx(() => {
      const old = this.#db.prepare('SELECT * FROM invitations WHERE request_id=?').get(request_id);
      if (old) {
        if (old.conversation_id !== conversation_id || Boolean(old.manual) !== manual) fail('invitation replay mismatch');
        return this.invitation(old.id);
      }
      const now = this.#now();
      if (!manual) {
        const rejection = this.#db.prepare('SELECT MAX(rejected_at) AS at FROM invitations').get().at;
        if (rejection !== null && rejection > now - DAY) fail('invitation cooldown', 429);
        const count = this.#db.prepare('SELECT count(*) AS n FROM invitations WHERE manual=0 AND created_at>?').get(now - DAY).n;
        if (count >= 3) fail('invitation limit', 429);
      }
      const invitationId = randomUUID();
      this.#db.prepare('INSERT INTO invitations(id,request_id,conversation_id,manual,state,created_at) VALUES(?,?,?,?,?,?)')
        .run(invitationId, request_id, conversation_id, +manual, 'pending', now);
      return this.invitation(invitationId);
    });
  }
  accept(invitationId) {
    return this.#tx(() => {
      const invitation = this.invitation(invitationId);
      if (invitation.state === 'rejected') fail('invitation rejected');
      if (invitation.state === 'accepted') {
        const session = this.session(invitationId);
        if (session.phase === 'deleted') fail('session phase deleted');
        return session;
      }
      this.#db.prepare("UPDATE invitations SET state='accepted' WHERE id=?").run(invitationId);
      this.#db.prepare("INSERT INTO sessions(id,conversation_id,phase) VALUES(?,?,'accepted')").run(invitationId, invitation.conversation_id);
      return this.session(invitationId);
    });
  }
  reject(invitationId) {
    return this.#tx(() => {
      const invitation = this.invitation(invitationId);
      if (invitation.state === 'accepted') fail('invitation already accepted');
      if (invitation.state !== 'rejected') this.#db.prepare("UPDATE invitations SET state='rejected',rejected_at=? WHERE id=?").run(this.#now(), invitationId);
      return this.invitation(invitationId);
    });
  }
  session(sessionId) {
    const row = this.#row(sessionId);
    return { id: row.id, conversation_id: row.conversation_id, revision: row.revision, phase: row.phase,
      question: row.question, spread_id: row.spread_id, draws: JSON.parse(row.draws),
      reading: row.reading_id ? this.reading(sessionId, row.reading_id) : null };
  }
  #event(sessionId, eventId, kind, payload, operation) {
    id(eventId, 'event_id');
    return this.#tx(() => {
      const row = this.#row(sessionId); this.#active(row);
      const fingerprint = digest({ kind, payload });
      const old = this.#db.prepare('SELECT * FROM receipts WHERE session_id=? AND event_id=?').get(sessionId, eventId);
      if (old) {
        if (old.fingerprint !== fingerprint) fail('event replay mismatch');
        return { session_id: sessionId, event_id: eventId, revision: old.revision };
      }
      operation(row); this.#bump(sessionId);
      const revision = this.#row(sessionId).revision;
      this.#db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(sessionId, eventId, fingerprint, revision);
      return { session_id: sessionId, event_id: eventId, revision };
    });
  }
  draw(sessionId, event) {
    const question = text(event.question, 4000, 'question');
    const spread_id = id(event.spread_id, 'spread_id');
    if (!Array.isArray(event.draws) || !event.draws.length || event.draws.length > 78) fail('invalid draws', 400);
    const draws = event.draws.map(card => {
      if (!card || !Number.isSafeInteger(card.position) || card.position < 0 || typeof card.reversed !== 'boolean') fail('invalid draw', 400);
      return { position: card.position, card_id: id(card.card_id, 'card_id'), reversed: card.reversed, revealed: false };
    }).sort((a, b) => a.position - b.position);
    if (draws.some((card, index) => card.position !== index) || new Set(draws.map(c => c.card_id)).size !== draws.length) fail('invalid duplicate or missing draw', 400);
    return this.#event(sessionId, event.event_id, 'draw', { question, spread_id, draws }, row => {
      if (row.phase !== 'accepted') fail('draw requires accepted phase');
      this.#db.prepare("UPDATE sessions SET phase='drawn',question=?,spread_id=?,draws=? WHERE id=?")
        .run(question, spread_id, JSON.stringify(draws), sessionId);
    });
  }
  reveal(sessionId, event) {
    if (!Array.isArray(event.positions) || !event.positions.length || event.positions.length > 78 ||
      event.positions.some(p => !Number.isSafeInteger(p) || p < 0) || new Set(event.positions).size !== event.positions.length) fail('invalid positions', 400);
    const positions = [...event.positions].sort((a, b) => a - b);
    return this.#event(sessionId, event.event_id, 'reveal', { positions }, row => {
      if (!['drawn', 'revealed'].includes(row.phase)) fail('reveal requires drawn phase');
      const draws = JSON.parse(row.draws);
      if (positions.some(p => p >= draws.length)) fail('invalid position', 400);
      for (const position of positions) draws[position].revealed = true;
      this.#db.prepare('UPDATE sessions SET phase=?,draws=? WHERE id=?')
        .run(draws.every(c => c.revealed) ? 'revealed' : 'drawn', JSON.stringify(draws), sessionId);
    });
  }
  reading(sessionId, attemptId) {
    this.#row(sessionId);
    const row = this.#db.prepare('SELECT * FROM readings WHERE id=? AND session_id=?').get(id(attemptId, 'attempt_id'), sessionId);
    if (!row) fail('reading not found', 404);
    return { ...row, source: JSON.parse(row.source) };
  }
  claimReading(sessionId, { action_id, model, source = {} }) {
    id(action_id, 'action_id');
    if (typeof model !== 'string' || !model.trim() || model.length > 256) fail('invalid model', 400);
    source = safeSource(source);
    return this.#tx(() => {
      const row = this.#row(sessionId); this.#active(row);
      if (row.phase !== 'revealed') fail('reading requires revealed phase');
      const old = this.#db.prepare('SELECT * FROM readings WHERE session_id=? AND action_id=?').get(sessionId, action_id);
      if (old) {
        if (old.model !== model || old.source !== JSON.stringify(source)) fail('reading replay mismatch');
        return { attempt: this.reading(sessionId, old.id), claimed: false };
      }
      if (row.reading_id && this.reading(sessionId, row.reading_id).state === 'running') fail('reading already running');
      const attemptId = randomUUID();
      this.#db.prepare("INSERT INTO readings(id,session_id,action_id,model,source,state) VALUES(?,?,?,?,?,'running')")
        .run(attemptId, sessionId, action_id, model, JSON.stringify(source));
      this.#db.prepare('UPDATE sessions SET reading_id=?,revision=revision+1 WHERE id=?').run(attemptId, sessionId);
      return { attempt: this.reading(sessionId, attemptId), claimed: true };
    });
  }
  appendReading(sessionId, attemptId, delta) {
    text(delta, 65_536, 'reading delta');
    return this.#tx(() => {
      const row = this.#row(sessionId); this.#active(row);
      const attempt = this.reading(sessionId, attemptId);
      if (attempt.state !== 'running' || row.reading_id !== attemptId) fail('reading state is not running');
      if (attempt.text.length + delta.length > 1_000_000) fail('reading text limit', 413);
      this.#db.prepare('UPDATE readings SET text=text||? WHERE id=?').run(delta, attemptId);
      this.#bump(sessionId); return this.reading(sessionId, attemptId);
    });
  }
  finishReading(sessionId, attemptId, state) {
    if (!['succeeded', 'failed', 'unknown', 'cancelled'].includes(state)) fail('invalid reading state', 400);
    return this.#tx(() => {
      const row = this.#row(sessionId); this.#active(row);
      const attempt = this.reading(sessionId, attemptId);
      if (attempt.state !== 'running' || row.reading_id !== attemptId) fail('reading state is not running');
      this.#db.prepare('UPDATE readings SET state=? WHERE id=?').run(state, attemptId);
      this.#bump(sessionId); return this.reading(sessionId, attemptId);
    });
  }
  #delivery({ event_id, conversation_id }) {
    id(event_id, 'event_id'); id(conversation_id, 'conversation_id');
    const row = this.#db.prepare('SELECT * FROM deliveries WHERE event_id=? AND conversation_id=?').get(event_id, conversation_id);
    if (!row) fail('delivery not found', 404);
    return row;
  }
  #deliveryView(row) {
    return { event_id: row.event_id, session_id: row.session_id, conversation_id: row.conversation_id,
      revision: row.revision, state: row.state, message_id: row.message_id };
  }
  returnSession(sessionId, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid revision', 400);
    return this.#tx(() => {
      const row = this.#row(sessionId);
      if (row.phase === 'deleted') fail('session phase deleted');
      const old = this.#db.prepare('SELECT * FROM deliveries WHERE session_id=?').get(sessionId);
      if (old) {
        if (revision !== old.requested_revision && revision !== row.revision) fail('return revision mismatch');
        return this.#deliveryView(old);
      }
      if (revision !== row.revision) fail('return revision mismatch');
      if (row.reading_id && this.reading(sessionId, row.reading_id).state === 'running') fail('reading still running');
      if (!['revealed', 'stopped'].includes(row.phase)) fail('return requires revealed cards or stopped session');
      this.#db.prepare("UPDATE sessions SET phase='returned',revision=revision+1 WHERE id=?").run(sessionId);
      const eventId = randomUUID();
      this.#db.prepare("INSERT INTO deliveries(event_id,session_id,conversation_id,revision,requested_revision,state) VALUES(?,?,?,?,?,'pending')")
        .run(eventId, sessionId, row.conversation_id, revision + 1, revision);
      return this.#deliveryView(this.#delivery({ event_id: eventId, conversation_id: row.conversation_id }));
    });
  }
  events(conversationId) {
    return this.#db.prepare('SELECT * FROM deliveries WHERE conversation_id=? ORDER BY rowid').all(id(conversationId, 'conversation_id')).map(row => this.#deliveryView(row));
  }
  /** Insertion-order pages use a non-recycling sequence, including across local
   * deletion/reopen. Cursor is public position metadata, not authentication.
   * Start a fresh traversal to reconcile state changes of previously seen IDs.
   */
  eventsPage(conversationId, { cursor, limit = 50 } = {}) {
    id(conversationId, 'conversation_id');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid limit', 400);
    let sequence = 0;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded = Buffer.from(cursor, 'base64url');
        if (decoded.toString('base64url') !== cursor) throw new Error();
        const value = JSON.parse(decoded.toString('utf8'));
        if (value.v !== 1 || value.c !== conversationId || !Number.isSafeInteger(value.s) || value.s < 0) throw new Error();
        sequence = value.s;
      } catch { fail('invalid cursor', 400); }
    }
    const rows = this.#db.prepare('SELECT * FROM deliveries WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(conversationId, sequence, limit + 1);
    const has_more = rows.length > limit; const page = rows.slice(0, limit);
    const next = page.at(-1)?.sequence ?? sequence;
    return { events: page.map(row => this.#deliveryView(row)), next_cursor: Buffer.from(JSON.stringify({ v: 1, c: conversationId, s: next })).toString('base64url'), has_more };
  }
  claimDelivery(ref) {
    return this.#tx(() => {
      const event = this.#delivery(ref); const claimed = event.state === 'pending';
      if (claimed) this.#db.prepare("UPDATE deliveries SET state='claimed' WHERE event_id=?").run(event.event_id);
      return { event: this.#deliveryView(this.#delivery(ref)), claimed };
    });
  }
  markDeliveryUnknown(ref) {
    return this.#tx(() => {
      const event = this.#delivery(ref);
      if (!['claimed', 'unknown'].includes(event.state)) fail('delivery must be claimed before unknown');
      this.#db.prepare("UPDATE deliveries SET state='unknown' WHERE event_id=?").run(event.event_id);
      return this.#deliveryView(this.#delivery(ref));
    });
  }
  ack({ event_id, conversation_id, message_id }) {
    id(message_id, 'message_id');
    return this.#tx(() => {
      const ref = { event_id, conversation_id }; const event = this.#delivery(ref);
      if (event.state === 'sent') {
        if (event.message_id !== message_id) fail('message acknowledgement mismatch');
        return this.#deliveryView(event);
      }
      if (!['claimed', 'unknown'].includes(event.state)) fail('delivery must be claimed before ack');
      this.#db.prepare("UPDATE deliveries SET state='sent',message_id=? WHERE event_id=?").run(message_id, event_id);
      return this.#deliveryView(this.#delivery(ref));
    });
  }
  stop(sessionId) {
    return this.#tx(() => {
      const row = this.#row(sessionId);
      if (row.phase === 'stopped') return this.session(sessionId);
      this.#active(row);
      this.#db.prepare("UPDATE readings SET state='cancelled' WHERE session_id=? AND state='running'").run(sessionId);
      this.#db.prepare("UPDATE sessions SET phase='stopped',revision=revision+1 WHERE id=?").run(sessionId);
      return this.session(sessionId);
    });
  }
  delete(sessionId) {
    const result = this.#tx(() => {
      const row = this.#row(sessionId);
      if (row.phase === 'deleted') return this.session(sessionId);
      this.#db.prepare('DELETE FROM readings WHERE session_id=?').run(sessionId);
      this.#db.prepare('DELETE FROM receipts WHERE session_id=?').run(sessionId);
      this.#db.prepare('DELETE FROM deliveries WHERE session_id=?').run(sessionId);
      this.#db.prepare("UPDATE sessions SET phase='deleted',question='',spread_id=NULL,draws='[]',reading_id=NULL,revision=revision+1 WHERE id=?").run(sessionId);
      return this.session(sessionId);
    });
    // Checkpoint discarded pages; external backups and open readers remain outside
    // this local deletion guarantee. Keep the consent/policy tombstone for replay.
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return result;
  }
  close() { if (this.#db) { this.#db.close(); this.#db = null; } }
}
