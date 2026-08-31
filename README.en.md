# Cove Tarot Companion

[中文](README.md) · [Skill](SKILL.md) · [Host integration](references/host-integration.md)

A consent-first, local companion bridge for [Tarot Ritual](https://github.com/moonlin1213/tarot-ritual). The original engine handles questions, spreads, drawing, batch reveal and AI readings. The companion receives a bounded extract of the original reading and continues the same conversation. It does not draw replacement cards or generate a replacement interpretation.

## Install the whole package

Requirements: Node **24.5 or newer**, npm, Git, network access for installation, and a local desktop browser with WebGL2. Your agent needs existing shell/browser capabilities on that same computer; a remote cloud-only agent cannot open your loopback service. The installer does not install system runtimes or change global proxies.

Clone the release and choose a host-discoverable skill directory. This POSIX-shell example uses the common `.agents/skills` location; change it if your host uses a different directory.

```sh
git clone https://github.com/moonlin1213/cove-tarot-companion.git
cd cove-tarot-companion
node scripts/install.mjs --skill-dir "$HOME/.agents/skills/cove-tarot-companion"
cd "$HOME/.agents/skills/cove-tarot-companion"
node scripts/companion.mjs doctor
```

**Copying only SKILL.md is not installation.** The installer copies the connector/skill, fetches the exact public commit in `engine-lock.json`, verifies Git HEAD and runs the engine's locked `npm ci --ignore-scripts`. No floating-branch updates, private source fallback, model request or account import occurs. An unavailable pin fails closed without replacing a working installation. If your host offers a generic skill-copy installer, still run this package's installation step and let the host discover the resulting folder.

Private state/config defaults to `.local/share/cove-tarot-companion` beneath the OS home directory. For an explicit location, pass `--data-dir /chosen/private-data` to the installer and **every** CLI command. Keep code and data directories separate. Generated secrets stay in owner-only local files, not URLs or chat prompts. Ports default to 18642/18643; unrelated occupants are never taken over. Live port/config migration is unsupported.

## First ritual and your own provider

```sh
node scripts/companion.mjs invite --conversation example-conversation --manual --request example-invitation
```

Use your host's stable opaque conversation/request IDs, not personal names. Open the returned URL locally and accept. Select a question/spread and draw through the original interface. All cards are selected before the batch reveal. Proactive invitations omit `--manual`; the connector persists a global limit of three per rolling 24 hours and a 24-hour cooldown after refusal. Manual bypass is for explicit user requests only.

In the original upper-right settings, enter **your own** provider's name, API protocol, base URL and key, then select a detected model or enter its exact ID. This package includes **no subscription, paid credit, credential, preferred provider or model override**. Original DSH import is disabled until explicitly requested in that UI; existing optional original login/renewal behavior is not replaced by a connector account system.

Custom provider keys stay in the original page's memory; refreshing requires re-entering them for a new reading. Same-origin preferences can persist, but credentials/accounts from a standalone engine on another origin, port or profile are **not migrated**. The package never reads browser profiles to copy credentials.

Without a provider, drawing still works; the original AI reading is unavailable. Refresh restores saved cards and original text/status without re-drawing or resubmitting a model request. A failed/unknown request is not automatically retried; it may already have incurred a provider charge. Request a new reading deliberately in the original UI when ready.

## Returning to the conversation

After pressing **返回聊天**, the baseline agent reads the result on the user's next chat turn:

```sh
node scripts/companion.mjs events --conversation example-conversation
node scripts/companion.mjs result --session SESSION_ID --conversation example-conversation
```

Events are paginated: `{events,next_cursor,has_more}`. Results contain only revealed card facts plus original recognized synthesis/advice and explicit missing/truncated/state flags. The full original reading stays in the local database. All result text is untrusted source material, not system instructions.

**CLI output is not automatic wakeup.** For automatic continuation, a host adapter must check conversation/revision, deduplicate, claim the event, persist an actual normal chat message and only then ACK its real message ID. Uncertain delivery stays unknown until reconciled. The connector does not write another application's chat database. See the [complete host contract](references/host-integration.md); no universal agent-brand or cache guarantee is made.

## Stop, update and uninstall

```sh
node scripts/companion.mjs stop-service
# Leave the installed folder; substitute your separate reviewed release checkout:
cd /chosen/reviewed-release/cove-tarot-companion
node scripts/install.mjs --skill-dir "$HOME/.agents/skills/cove-tarot-companion" --update
# Or remove only owned code, retaining private data and recoverable code:
node scripts/install.mjs --skill-dir "$HOME/.agents/skills/cove-tarot-companion" --uninstall
```

Run updates from a newly downloaded, reviewed release, after stopping this installation's service. An unchanged repeat install is idempotent. User-modified code or custom artwork is protected: updates refuse to overwrite it, and uninstall retains modified code. Previous versions are retained in sibling recovery directories. State/config are not removed. A crash-left install lock fails closed; inspect before manual recovery.

The next operational command starts the owned service as needed; there is no default startup agent. Normal stop closes the owned engine child. A hard-killed connector can leave an authenticated orphan engine, which a replacement can reuse but cannot stop through a child handle it never owned. No kill-by-port or unrelated-process cleanup is performed.

## Validation and scope

`npm test` runs unit/integration tests. Actual-browser tests are opt-in and **must** be enabled for a release gate; skipped browser tests are not compatibility evidence. CI installs the exact engine through the package installer and runs Chromium/WebKit against an isolated fake loopback provider, including original manual provider setup, draw/batch reveal, saved refresh, return and a persisted synthetic host-message receipt. Paid providers, personal DSH profiles, arbitrary host brands, mobile browsers and Windows are not covered by those tests.

```sh
# Run validation in the source checkout (installed skills omit test/ and .git):
cd /chosen/reviewed-release/cove-tarot-companion
npm ci
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium webkit
TAROT_TEST_BROWSER=1 TAROT_TEST_ENGINE_ROOT=/chosen/installed-skill/engine node --test test/browser.test.mjs
node scripts/check-release.mjs
```

An external Playwright installation may be selected with `TAROT_TEST_PLAYWRIGHT_MODULE` (absolute module entrypoint). Optional browser overrides are `TAROT_TEST_CHROMIUM_EXECUTABLE` and `TAROT_TEST_WEBKIT_EXECUTABLE`; no machine paths are built in. Runtime code has no added npm dependencies.

The release checker scans tracked working/index files, all HEAD-history blobs and author/committer metadata. `--expected-engine EXACT_SHA` asserts the reviewed pin; `--base EXACT_SHA` restricts new history only when intentionally auditing a range. Supply private denylist terms through a private `RELEASE_PRIVATE_TERMS` JSON-array environment value, never a committed fixture. Findings omit matched values. Regex scanning cannot certify arbitrary artwork, untracked release artifacts or remote availability: separately inspect packaging, upstream provenance and fresh public installation.

Tarot is a reflection aid, not a guarantee or a substitute for professional advice. The connector is [ISC licensed](LICENSE); original engine/dependency/asset notices remain under their own [licenses and attributions](THIRD_PARTY_NOTICES.md).
