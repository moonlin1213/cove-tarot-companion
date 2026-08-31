import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';

const DAY = 86_400_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tarot-store-'));
  let now = 10 * DAY;
  let store = new Store(join(dir, 'state.sqlite'), { clock: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, tick(ms) { now += ms; },
    reopen() { store.close(); store = new Store(join(dir, 'state.sqlite'), { clock: () => now }); return store; },
    path: join(dir, 'state.sqlite') };
}
function accepted(store, key = 'one') {
  const invitation = store.invite({ conversation_id: key, request_id: key, manual: true });
  return store.accept(invitation.id).id;
}
const drawEvent = { event_id: 'draw', question: 'A synthetic question?', spread_id: 'pair',
  draws: [{ position: 0, card_id: 'C1', reversed: false }, { position: 1, card_id: 'C2', reversed: true }] };
function revealed(store, key) {
  const id = accepted(store, key);
  store.draw(id, drawEvent);
  store.reveal(id, { event_id: 'reveal', positions: [0, 1] });
  return id;
}
const readAction = { action_id: 'read', model: 'synthetic-model', source: { display: 'Synthetic source' } };

test('global rolling policy persists across restart and excludes explicit manual invitations', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.store.invite({ conversation_id: 'c' + i, request_id: 'r' + i, manual: false });
  f.reopen();
  assert.throws(() => f.store.invite({ conversation_id: 'c4', request_id: 'r4', manual: false }), /limit/);
  assert.ok(f.store.invite({ conversation_id: 'manual', request_id: 'manual', manual: true }).id);
  f.tick(DAY - 1);
  assert.throws(() => f.store.invite({ conversation_id: 'c4', request_id: 'r4', manual: false }), /limit/);
  f.tick(1);
  assert.ok(f.store.invite({ conversation_id: 'c4', request_id: 'r4', manual: false }).id);
});

test('rejection sets a global 24h cooldown; manual bypass does not clear it', t => {
  const f = fixture(t);
  const invite = f.store.invite({ conversation_id: 'a', request_id: 'a', manual: false });
  f.store.reject(invite.id);
  f.tick(DAY - 1);
  accepted(f.store, 'manual');
  assert.throws(() => f.store.invite({ conversation_id: 'b', request_id: 'b', manual: false }), /cooldown/);
  f.tick(1);
  assert.ok(f.store.invite({ conversation_id: 'b', request_id: 'b', manual: false }).id);
  assert.throws(() => f.store.accept(invite.id), /rejected/);
});

test('invitations replay stably, reject mismatches, and require consent before session work', t => {
  const { store } = fixture(t);
  const body = { conversation_id: 'a', request_id: 'req', manual: true };
  const invite = store.invite(body);
  assert.deepEqual(store.invite(body), invite);
  assert.deepEqual(store.invitation(invite.id), invite);
  assert.throws(() => store.invite({ ...body, conversation_id: 'b' }), /mismatch/);
  assert.throws(() => store.invite({ ...body, manual: false }), /mismatch/);
  assert.throws(() => store.session(invite.id), /consent/);
  assert.throws(() => store.draw(invite.id, drawEvent), /consent/);
  assert.equal(store.accept(invite.id).phase, 'accepted');
  assert.equal(store.accept(invite.id).revision, 0);
  assert.throws(() => store.reject(invite.id), /accepted/);
});

test('draw and reveal receipts survive replay while mismatches and replacement draws fail', t => {
  const f = fixture(t); const id = accepted(f.store);
  const receipt = f.store.draw(id, drawEvent);
  assert.deepEqual(receipt, { session_id: id, event_id: 'draw', revision: 1 });
  assert.deepEqual(f.store.draw(id, drawEvent), receipt);
  assert.throws(() => f.store.draw(id, { ...drawEvent, question: 'Changed' }), /mismatch/);
  assert.throws(() => f.store.draw(id, { ...drawEvent, event_id: 'other' }), /phase/);
  assert.throws(() => f.store.reveal(id, { event_id: 'draw', positions: [0] }), /mismatch/);
  const reveal = f.store.reveal(id, { event_id: 'first', positions: [0] });
  f.reopen();
  assert.deepEqual(f.store.reveal(id, { event_id: 'first', positions: [0] }), reveal);
  assert.equal(f.store.session(id).phase, 'drawn');
  assert.deepEqual(f.store.session(id).draws.map(c => c.revealed), [true, false]);
  f.store.reveal(id, { event_id: 'second', positions: [1] });
  assert.equal(f.store.session(id).phase, 'revealed');
});

test('malformed bounded input fails atomically and cannot create state', t => {
  const { store } = fixture(t);
  for (const body of [ { conversation_id: '', request_id: 'r', manual: true },
    { conversation_id: 'x', request_id: 'r', manual: 'true' },
    { conversation_id: '../x', request_id: 'r', manual: true } ]) assert.throws(() => store.invite(body));
  const id = accepted(store);
  for (const draws of [[], [{ position: NaN, card_id: 'C1', reversed: false }],
    [{ position: 0, card_id: 'C1', reversed: 1 }],
    [{ position: 0, card_id: 'C1', reversed: false }, { position: 1, card_id: 'C1', reversed: false }]]) {
    assert.throws(() => store.draw(id, { ...drawEvent, draws }));
    assert.equal(store.session(id).revision, 0);
  }
  assert.throws(() => store.draw(id, { ...drawEvent, question: 'x'.repeat(4001) }));
  store.draw(id, drawEvent);
  for (const positions of [[], [-1], [2], [0, 0], [Infinity], ['0']]) {
    assert.throws(() => store.reveal(id, { event_id: 'bad', positions }));
    assert.equal(store.session(id).revision, 1);
  }
});

test('reading requires all reveals, claims once, and preserves full original partial text', t => {
  const { store } = fixture(t); const id = accepted(store);
  assert.throws(() => store.claimReading(id, readAction), /phase/);
  store.draw(id, drawEvent);
  assert.throws(() => store.claimReading(id, readAction), /phase/);
  store.reveal(id, { event_id: 'reveal', positions: [0, 1] });
  const first = store.claimReading(id, readAction);
  assert.equal(first.claimed, true);
  assert.equal(first.attempt.state, 'running');
  const replay = store.claimReading(id, readAction);
  assert.equal(replay.claimed, false);
  assert.equal(replay.attempt.id, first.attempt.id);
  assert.throws(() => store.claimReading(id, { ...readAction, model: 'changed' }), /mismatch/);
  assert.throws(() => store.claimReading(id, { ...readAction, action_id: 'new' }), /running/);
  store.appendReading(id, first.attempt.id, '### 综合信息\n');
  store.appendReading(id, first.attempt.id, 'Original unfinished text');
  store.finishReading(id, first.attempt.id, 'failed');
  assert.equal(store.session(id).reading.text, '### 综合信息\nOriginal unfinished text');
  assert.throws(() => store.appendReading(id, first.attempt.id, 'late'), /state/);
  assert.equal(store.claimReading(id, readAction).claimed, false);
  const second = store.claimReading(id, { ...readAction, action_id: 'new' });
  assert.equal(second.claimed, true);
  assert.equal(store.reading(id, first.attempt.id).state, 'failed');
  assert.throws(() => store.finishReading(id, second.attempt.id, 'imagined'));
  store.finishReading(id, second.attempt.id, 'succeeded');
  assert.equal(store.session(id).phase, 'revealed');
});

test('restart changes interrupted paid work to unknown without reclaim or text loss', t => {
  const f = fixture(t); const id = revealed(f.store);
  const { attempt } = f.store.claimReading(id, readAction);
  f.store.appendReading(id, attempt.id, 'Saved partial');
  f.reopen();
  assert.equal(f.store.session(id).reading.state, 'unknown');
  assert.equal(f.store.session(id).reading.text, 'Saved partial');
  assert.equal(f.store.claimReading(id, readAction).claimed, false);
  assert.throws(() => f.store.appendReading(id, attempt.id, 'late'), /state/);
  assert.equal(f.store.claimReading(id, { ...readAction, action_id: 'deliberate' }).claimed, true);
});

test('source ledger rejects providers, URLs, credentials, and oversized metadata', t => {
  const { store } = fixture(t); const id = revealed(store);
  for (const source of [ { display: 'Synthetic', apiKey: 'not-a-secret' },
    { display: 'Synthetic', provider: {} }, { display: 'https://example.invalid' },
    { display: 'Bearer abc' }, { display: 'mailto:person@example.invalid' },
    { display: 'www.example.invalid/path' }, { display: 'Synthetic\u001b[31m' },
    { display: 'x'.repeat(161) }, 'Synthetic' ]) {
    assert.throws(() => store.claimReading(id, { ...readAction, source }), /source/);
  }
  const { attempt } = store.claimReading(id, readAction);
  assert.deepEqual(attempt.source, { display: 'Synthetic source' });
  assert.equal(attempt.model, 'synthetic-model');
});

test('paid attempt lookups and writes cannot cross session boundaries', t => {
  const { store } = fixture(t);
  const first = revealed(store, 'first'); const second = revealed(store, 'second');
  const a = store.claimReading(first, readAction).attempt;
  const b = store.claimReading(second, readAction).attempt;
  assert.notEqual(a.id, b.id);
  assert.throws(() => store.reading(second, a.id), /not found/);
  assert.throws(() => store.appendReading(second, a.id, 'wrong destination'), /not found/);
  assert.throws(() => store.finishReading(second, a.id, 'failed'), /not found/);
  assert.equal(store.reading(first, a.id).text, '');
  assert.equal(store.reading(second, b.id).state, 'running');
});

test('rolling limit expires individual invitations rather than resetting at midnight', t => {
  const f = fixture(t);
  f.tick(DAY - 1000);
  f.store.invite({ conversation_id: 'a', request_id: 'a', manual: false });
  f.tick(500);
  f.store.invite({ conversation_id: 'b', request_id: 'b', manual: false });
  f.tick(500);
  f.store.invite({ conversation_id: 'c', request_id: 'c', manual: false });
  assert.throws(() => f.store.invite({ conversation_id: 'd', request_id: 'd', manual: false }), /limit/);
  f.tick(DAY - 1000);
  assert.ok(f.store.invite({ conversation_id: 'd', request_id: 'd', manual: false }).id);
  assert.throws(() => f.store.invite({ conversation_id: 'e', request_id: 'e', manual: false }), /limit/);
  f.tick(500);
  assert.ok(f.store.invite({ conversation_id: 'e', request_id: 'e', manual: false }).id);
});

test('failed bounded append leaves original text unchanged and preserves paid claim', t => {
  const { store } = fixture(t); const sessionId = revealed(store);
  const { attempt } = store.claimReading(sessionId, readAction);
  store.appendReading(sessionId, attempt.id, 'Original');
  const revision = store.session(sessionId).revision;
  for (const delta of ['x'.repeat(65_537), 'bad\0delta', null]) {
    assert.throws(() => store.appendReading(sessionId, attempt.id, delta));
    assert.equal(store.session(sessionId).revision, revision);
  }
  assert.equal(store.reading(sessionId, attempt.id).text, 'Original');
  assert.equal(store.claimReading(sessionId, readAction).claimed, false);
});

test('return requires current revision, revealed cards, and no running reading', t => {
  const { store } = fixture(t); const id = accepted(store);
  assert.throws(() => store.returnSession(id, 0), /reveal/);
  store.draw(id, drawEvent); store.reveal(id, { event_id: 'r', positions: [0, 1] });
  const { attempt } = store.claimReading(id, readAction);
  assert.throws(() => store.returnSession(id, store.session(id).revision), /running/);
  store.finishReading(id, attempt.id, 'failed');
  assert.throws(() => store.returnSession(id, 0), /revision/);
  const revision = store.session(id).revision;
  const event = store.returnSession(id, revision);
  assert.equal(event.state, 'pending');
  assert.equal(store.session(id).phase, 'returned');
  assert.deepEqual(store.returnSession(id, revision), event);
  assert.equal(store.events('one').length, 1);
  assert.throws(() => store.claimReading(id, { ...readAction, action_id: 'late' }), /phase/);
});

test('delivery is conversation scoped, claim before real message ack, and stably deduplicated', t => {
  const { store } = fixture(t); const id = revealed(store);
  const event = store.returnSession(id, store.session(id).revision);
  assert.deepEqual(store.events('other'), []);
  const ref = { event_id: event.event_id, conversation_id: 'one' };
  assert.throws(() => store.ack({ ...ref, message_id: 'msg' }), /claimed/);
  assert.throws(() => store.claimDelivery({ ...ref, conversation_id: 'other' }), /not found/);
  assert.equal(store.claimDelivery(ref).claimed, true);
  assert.equal(store.claimDelivery(ref).claimed, false);
  assert.throws(() => store.ack({ ...ref, message_id: '' }));
  assert.throws(() => store.ack({ ...ref, conversation_id: 'other', message_id: 'msg' }), /not found/);
  const sent = store.ack({ ...ref, message_id: 'msg' });
  assert.equal(sent.state, 'sent');
  assert.deepEqual(store.ack({ ...ref, message_id: 'msg' }), sent);
  assert.throws(() => store.ack({ ...ref, message_id: 'different' }), /mismatch/);
  assert.equal(store.claimDelivery(ref).claimed, false);
});

test('crashed or explicitly uncertain delivery becomes unknown and is never auto-reclaimed', t => {
  const f = fixture(t); const id = revealed(f.store);
  const event = f.store.returnSession(id, f.store.session(id).revision);
  const ref = { event_id: event.event_id, conversation_id: 'one' };
  f.store.claimDelivery(ref); f.reopen();
  assert.equal(f.store.events('one')[0].state, 'unknown');
  assert.equal(f.store.claimDelivery(ref).claimed, false);
  assert.equal(f.store.markDeliveryUnknown(ref).state, 'unknown');
  assert.equal(f.store.ack({ ...ref, message_id: 'confirmed-existing' }).state, 'sent');
});

test('stop cancels active reading, freezes mutations, but allows revealed-only partial return', t => {
  const { store } = fixture(t); const id = revealed(store);
  const { attempt } = store.claimReading(id, readAction);
  store.appendReading(id, attempt.id, 'partial');
  const stopped = store.stop(id);
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.reading.state, 'cancelled');
  assert.deepEqual(store.stop(id), stopped);
  assert.throws(() => store.appendReading(id, attempt.id, 'late'), /phase/);
  assert.throws(() => store.finishReading(id, attempt.id, 'succeeded'), /phase/);
  assert.throws(() => store.draw(id, drawEvent), /phase/);
  assert.throws(() => store.reveal(id, { event_id: 'reveal', positions: [0, 1] }), /phase/);
  assert.equal(store.returnSession(id, stopped.revision).state, 'pending');
  const partial = accepted(store, 'partial');
  store.draw(partial, drawEvent); store.reveal(partial, { event_id: 'r', positions: [0] });
  store.stop(partial);
  assert.equal(store.returnSession(partial, store.session(partial).revision).state, 'pending');
});

test('delete erases session content and pending delivery while retaining a terminal tombstone', t => {
  const f = fixture(t); const id = revealed(f.store);
  const { attempt } = f.store.claimReading(id, readAction);
  f.store.appendReading(id, attempt.id, 'private synthetic reading');
  f.store.finishReading(id, attempt.id, 'succeeded');
  const event = f.store.returnSession(id, f.store.session(id).revision);
  const deleted = f.store.delete(id);
  assert.equal(deleted.phase, 'deleted'); assert.equal(deleted.question, '');
  assert.deepEqual(deleted.draws, []); assert.equal(deleted.reading, null);
  assert.deepEqual(f.store.events('one'), []);
  assert.deepEqual(f.store.delete(id), deleted);
  for (const op of [() => f.store.appendReading(id, attempt.id, 'late'),
    () => f.store.finishReading(id, attempt.id, 'succeeded'), () => f.store.draw(id, drawEvent),
    () => f.store.accept(id), () => f.store.returnSession(id, deleted.revision),
    () => f.store.claimDelivery({ event_id: event.event_id, conversation_id: 'one' })]) assert.throws(op);
  f.reopen(); assert.equal(f.store.session(id).phase, 'deleted');
});

test('actual file uses WAL and persistent unique invitation claims', t => {
  const f = fixture(t);
  const invite = f.store.invite({ conversation_id: 'c', request_id: 'r', manual: false });
  const db = new DatabaseSync(f.path);
  try { assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); } finally { db.close(); }
  f.reopen(); assert.equal(f.store.invitation(invite.id).state, 'pending');
  assert.equal(f.store.invite({ conversation_id: 'c', request_id: 'r', manual: false }).id, invite.id);
});
