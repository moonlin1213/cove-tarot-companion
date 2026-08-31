# Standalone Tarot Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish cove-tarot-companion with single-flow installation of public Tarot Ritual, original professional reading and local agent result delivery.

**Architecture:** A Node local companion server serves the original engine UI at a stable origin and forwards provider requests to a separately owned loopback engine. An optional UI seam persists draws before reveal and routes readings through the companion's durable stream recorder. A SQLite ledger and CLI provide invitations, results and host receipts without new model tools.

**Tech Stack:** Node >=24.5, built-in HTTP/fetch/crypto/SQLite/test; original Tarot UI/Three.js; development Playwright. No runtime Python.

**Spec:** docs/superpowers/specs/2026-09-01-cove-tarot-companion-design.md

## Global Constraints

- Name cove-tarot-companion; Tarot only; no private identities, paths, records, credentials, artwork or Git history.
- Keep original provider UI/defaults/OAuth/prompt/protocol. Custom credentials remain ephemeral; no second provider database.
- Proactive invitation maximum 3 per rolling 24h; reject cooldown 24h; explicit manual request bypasses these limits.
- Consent before engine use; no rerandomization or paid request on restore; unknown attempts never automatically retry.
- Return original question/spread/revealed card names/orientations/final synthesis and advice. Missing reading is explicit, never invented.
- Localhost only, session isolation, bounded input/output, secret files not URL tokens. No host DB writes or hidden model calls.
- New public history with project identity; required public source URL and licenses preserved. Tests synthetic. No production edits/restarts.

## Shared wire contract and files

Engine files: public/js/companion-adapter.js optional client; main.js lifecycle hooks; ai.js optional response transport; three/cards3d.js restoration; test/ companion fixtures. Skill files: src/store.mjs transactions; src/result.mjs canonical facts/synthesis; src/server.mjs HTTP/streams; src/engine.mjs fixed child/proxy; src/config.mjs secret install data; scripts/companion.mjs CLI; scripts/install.mjs installer; public/invitation.html consent; engine-lock.json pin; SKILL.md/references docs; test/ synthetic validation.

Page config: JSON script id companion-config, type application/json, {protocol:"cove-tarot-companion-v1",sessionId:"...",apiBase:"/companion/v1"}. No config means no new requests/standalone changes. Only that exact apiBase allowed. IDs: 1..128 ASCII letters, digits, underscore or hyphen.

Session: {id,conversation_id,revision,phase,question,spread_id,draws:[{position,card_id,reversed,revealed}],reading:{id,state,text}|null}; positions zero-based. Bootstrap: {session,csrf_token}.

Browser /companion/v1/sessions/:id routes:

- GET bootstrap.
- POST /draw {event_id,question,spread_id,draws:[{position,card_id,reversed}]}.
- POST /reveal {event_id,positions:[number]}.
- POST /reading {action_id,providerId?,provider?,model,temperature?,maxTokens?}; GET /reading?attempt_id=... resume only.
- POST /return {revision}; POST /stop {}; POST /delete {confirm:true}.

All POSTs require bound cookie, X-Companion-CSRF, exact Host/Origin. Changed payload under reused ID is 409. Draw/reveal receipt {session_id,event_id,revision}. Server reconstructs original prompts from stored canonical facts using original buildReadingMessages; browser messages ignored. Provider request data must never reach DB/logs/events.

Reading SSE: original {t:"delta",v:string}, {t:"error",v:string}, {t:"done"}. Capture original upstream, persist terminal state before closing subscribers, EOF without success is unknown. GET observes/replays accepted attempt without new upstream.

Admin uses per-install file token, not URL. Routes: GET /companion/v1/health; POST /companion/v1/invitations {conversation_id,request_id,manual}; GET /companion/v1/events?conversation_id=...; GET /companion/v1/results/:id?conversation_id=...; POST /companion/v1/ack {event_id,conversation_id,message_id}. Host delivery claim/unknown handling prevents ambiguous retries. Only actual persisted host message earns ack. No automatic host models in connector.

### Task 1: Public engine optional UI seam

**Files:** engine public/js/companion-adapter.js, main.js, ai.js, three/cards3d.js; test/companion-adapter.test.mjs, test/companion-ui.test.mjs, COMPANION.md.

**Interfaces:** createCompanionAdapter(config,{fetchImpl=fetch}={}) returns null without config, else {restore,commitDraw,reveal,read,returnToChat,stop}; read(body,{signal}={}) returns Response and accepts attempt_id only for GET resume. chat accepts optional transport(body,{signal}) while preserving original callbacks. Shared wire contract above is binding.

- [ ] RED adapter behavior tests and original UI fixture tests: inactive standalone, invalid origin/base, exact replay after lost ACK, reveal delayed until draw ACK, restored cards/reading without random/new request, unchanged manual/DSH settings and original chat parsing.

      const mod=await import('../public/js/companion-adapter.js').catch(()=>({}));
      assert.equal(typeof mod.createCompanionAdapter,'function');
      assert.equal(mod.createCompanionAdapter(null),null);

- [ ] Implement bootstrap-before-controls and serialized durable browser outbox scoped to session. Failed ACK retains event and freezes relevant controls. Restore exact committed cards/orientations, render stored text and unknown status, never start a new read on refresh. Preserve whole-spread batch reveal, zoom, title and photo behavior. Return/stop controls neutral and managed-only. No provider still permits draw and truthful result. New question/reset cannot overwrite committed session.

      await fetchImpl(endpoint+'/draw',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json','X-Companion-CSRF':csrf},
        body:JSON.stringify(durableEvent)
      });

- [ ] GREEN focused and full original tests/check, self-review and commit public files with project identity. No push. Engine server/provider logic stays original; any passive compatibility edit needs direct regression test.

### Task 2: Persistent state and original synthesis

**Files:** skill package.json, .gitignore, src/store.mjs, src/result.mjs; test/store.test.mjs, test/result.test.mjs.

**Interfaces:** new Store(dbPath,{clock=Date.now}={}); invite({conversation_id,request_id,manual}), accept(id), reject(id), session(id), draw(id,event), reveal(id,event), claimReading(id,{action_id,model,source}), appendReading(id,attemptId,delta), finishReading(id,attemptId,state), returnSession(id,revision), events(conversationId), ack({event_id,conversation_id,message_id}), stop(id), delete(id), close(). Add explicit delivery claim/unknown primitives if needed. Source stores only safe display/model, not provider objects or URLs.

canonicalDraw(payload,{deck,spreads}) validates original catalog/card positions and returns canonical names; buildResult(session,{deck,spreads,maxChars=3500}) returns bounded untrusted JSON; extractSynthesis(text) extracts original 综合信息/建议 with qualifications, no arbitrary tail.

- [ ] RED actual temporary SQLite tests for rolling/global policy, cooldown/manual bypass, event replay/mismatch, strict transition validation, accepted/unknown attempts not reclaimed, partial text, stopped/deleted late writes, crash recovery, return/ack dedupe and cross-conversation isolation. Hand-derived result fixtures for unrevealed cards/fenced fake headings/missing synthesis/truncation.

      for(let i=0;i<3;i++)store.invite({conversation_id:'c'+i,request_id:'r'+i,manual:false});
      assert.throws(()=>store.invite({conversation_id:'c4',request_id:'r4',manual:false}),/limit/);
      assert.ok(store.invite({conversation_id:'m',request_id:'m',manual:true}).id);

- [ ] Implement WAL SQLite, immediate transactions/unique IDs, finite bounded inputs, explicit state transitions. On startup interrupted reads/delivery become unknown, not new requests.

      db.exec('BEGIN IMMEDIATE');
      try{const result=operation();db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}

- [ ] GREEN full current tests, self-review/commit. SQLite experimental warning may be documented; never suppress unrelated failures.

### Task 3: Authenticated service, installer and CLI

**Files:** skill src/server.mjs, src/engine.mjs, src/config.mjs, scripts/companion.mjs, scripts/install.mjs, public/invitation.html, engine-lock.json; test/server.test.mjs, test/engine.test.mjs, test/install.test.mjs, test/cli.test.mjs.

**Interfaces:** createService({config,store,engine}) owns server/close; Engine takes fixed root/executable/port/environment and launches node --use-env-proxy server.mjs only after acceptance. CLI commands doctor, serve, invite --conversation ID [--manual], events --conversation ID, result --session ID --conversation ID, ack --event ID --conversation ID --message ID, stop-service, all support --data-dir. Installer node scripts/install.mjs --data-dir DIR --skill-dir DIR supports repeated safe install, explicit update and code-only uninstall retaining data.

- [ ] RED real HTTP with Store and local fake original upstream: bad Host/Origin/CSRF, wrong session, bounded bodies/streams, no engine before consent, original providers without persisted secrets, SSE success/error/EOF/disconnect/replay, restart and duplicate host return. Actual child lifecycle tests: refusal vs occupied, own-only cleanup, concurrent start, proxy flags, cold restart, completed read without engine. Installer real temp-Git fixtures test wrong pin/partial failures/unsafe destinations/modified files/idempotency. CLI is spawned for output and side effects.

      await postReading({action_id:'same',provider:fakeProvider,model:'test-model'});
      await postReading({action_id:'same',provider:fakeProvider,model:'test-model'});
      assert.equal(fakeUpstream.calls,1);
      assert.equal(store.session(id).reading.state,'succeeded');

- [ ] Implement cookie/CSRF local service, fixed proxy routes, escaped JSON injection, allowlisted public static tree, no dotfiles/traversal/symlink escapes. Rebuild prompts from canonical records/public engine builder, original /api/chat transport unchanged. Persist claim before upstream; worker survives browser disconnect; no secret hashing/logging/storage.
- [ ] Install exact public repo+40-character commit from manifest, verify actual checkout, npm ci lockfile, fresh owned staging directory and config switch only after success. Never overwrite non-owned/modified code; stable origin and separate data preserved. No account/profile migration, global installation or boot agents. Incomplete/missing pin fails closed.
- [ ] Neutral consent page and CLI lazy authenticated service; engine starts only after accept. Secret files restricted and regular; stop only owned authenticated processes. Original import/manual provider routes supported at stable origin.
- [ ] GREEN full skill/original integration, self-review, commit exact files. No production changes.

### Task 4: Discoverable skill, host docs and release acceptance

**Files:** SKILL.md, agents/openai.yaml, README.md, README.en.md, references/host-integration.md, LICENSE, THIRD_PARTY_NOTICES.md, scripts/check-release.mjs, test/browser.test.mjs, test/release.test.mjs, .github/workflows/test.yml.

**Interfaces:** installer and CLI from Task 3; host docs describe claim/read/real host message/ack ordering. Stdout is not hidden context/wakeup. Skill auto-discoverable with existing shell/browser only.

- [ ] RED real engine browser E2E, local fake upstream: accept, original settings/manual provider, original draw/batch reveal/read, refresh/return/result/host receipt and repeated return. Chromium and WebKit; providerless and failed results. Fix observed integration gaps via task owners.
- [ ] Validate clean package CLI/help/install, skill quick validator and independent agent forward-test using synthetic inputs only.
- [ ] Write concise guides with first provider setup, opt-in DSH, no bundled subscription, local browser prerequisite and honest host auto-return requirements. Include ISC and upstream notices; no private examples/assets.
- [ ] Release checker tests synthetic planted secret/private-path detection; scan tracked artifacts and all new commit metadata, source URL allowlist and exact engine pin. Never put actual private identities in public test fixtures.
- [ ] Commit and run full gates; task review and broad final review. Controller publishes audited engine, pins actual public commit, creates public skill repo, pushes clean main without force, validates remote hashes and clean installation. No untested real-provider/host/platform claims.

## Self-review

The single wire contract binds tasks 1–3. Credentials remain original ephemeral inputs, not connector configuration. Public engine pin is assigned only from actual reviewed publication. All model requests in tests target local synthetic servers. Public upstream URL is necessary attribution, not private runtime data. Host automatic delivery remains an explicit adapter contract.
