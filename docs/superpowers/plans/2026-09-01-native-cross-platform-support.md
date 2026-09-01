# Native Windows, macOS, and Linux Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cove-tarot-companion install, run, update, diagnose, and uninstall natively on Windows 10/11 x64, macOS Intel/Apple Silicon, and Linux x64 without changing Tarot Ritual provider or reading behavior.

**Architecture:** Add a small `src/platform.mjs` boundary for path identity, private storage, external commands, filesystem replacement, and owned-child lifecycle. Existing config, installer, CLI, and engine code consume those functions while invitation, persistence, provider, UI, and result contracts remain unchanged. Native GitHub Actions jobs prove the behavior on all four supported runner architectures before documentation claims support.

**Tech Stack:** Node.js >=24.5 built-ins, Windows PowerShell/.NET ACL APIs, POSIX filesystem permissions, GitHub Actions, Playwright Chromium/WebKit. No new runtime npm dependency, compiled extension, WSL, Git Bash, Docker, or Python.

**Spec:** `docs/superpowers/specs/2026-09-01-native-cross-platform-support-design.md`

## Global Constraints

- Supported release targets: Windows 10/11 x64, macOS Intel, macOS Apple Silicon, Linux x64.
- Keep macOS/Linux data at `~/.local/share/cove-tarot-companion`; use `%LOCALAPPDATA%\cove-tarot-companion` on Windows.
- Preserve provider lists, DSH/OAuth/custom-provider behavior, model defaults, prompts, draw/reveal/zoom UI, reading transport, invitation policy, saved results, and custom artwork.
- Use only system Node/Git/npm/PowerShell capabilities; do not add runtime dependencies or install system software.
- Never interpolate user paths into a shell command. Pass paths as process options, argument-array values, or a task-specific environment value read by a static PowerShell program.
- Never identify or kill a process by port. Stop only a held child handle created by this installation.
- Refuse unsafe ACLs, links/reparse points, network/device data paths, path overlap, unverifiable replacement, and identity mismatches before secrets or code switches.
- Existing macOS/Linux tests remain real behavior tests and cannot be replaced with source-text assertions or platform skips.
- Each production behavior begins with a test that is observed failing for the expected reason.

---

### Task 1: Platform path and private-storage boundary

**Files:**
- Create: `src/platform.mjs`
- Create: `test/platform.test.mjs`
- Modify: `src/config.mjs`
- Modify: `test/engine.test.mjs`

**Interfaces:**
- `defaultPrivateDataDir({ platform = process.platform, environment = process.env, home = os.homedir() } = {}) -> string`
- `pathsOverlap(left, right, { platform = process.platform } = {}) -> boolean`
- `assertLocalPath(target, { platform = process.platform } = {}) -> void`
- `ensurePrivateDirectory(directory, options = {}) -> Promise<string>`
- `readPrivateFile(filename, options = {}) -> Promise<string>`
- `assertPrivateFile(filename, options = {}) -> Promise<void>`
- `isPosix({ platform = process.platform } = {}) -> boolean`
- `config.mjs` keeps the public names `defaultDataDir`, `privateDirectory`, and `secureFile` as thin delegates so current consumers do not change in this task.

- [ ] **Step 1: Write path-default and path-identity failures**

  Add table-driven literal expectations to `test/platform.test.mjs`:

  ```js
  const linuxFixtureHome = path.posix.join(path.posix.sep, 'home', 'fixture');
  const macOSFixtureHome = path.posix.join(path.posix.sep, 'Users', 'fixture');
  const windowsFixtureHome = path.win32.join('C:' + path.win32.sep, 'Users', 'Fixture');
  const windowsFixtureLocalAppData = path.win32.join(windowsFixtureHome, 'AppData', 'Local');

  test('data defaults preserve POSIX installs and use LOCALAPPDATA on Windows', () => {
    assert.equal(defaultPrivateDataDir({ platform: 'linux', home: linuxFixtureHome, environment: {} }), path.posix.join(linuxFixtureHome, '.local', 'share', 'cove-tarot-companion'));
    assert.equal(defaultPrivateDataDir({ platform: 'darwin', home: macOSFixtureHome, environment: {} }), path.posix.join(macOSFixtureHome, '.local', 'share', 'cove-tarot-companion'));
    assert.equal(defaultPrivateDataDir({ platform: 'win32', home: windowsFixtureHome, environment: { LOCALAPPDATA: windowsFixtureLocalAppData } }), path.win32.join(windowsFixtureLocalAppData, 'cove-tarot-companion'));
    assert.throws(() => defaultPrivateDataDir({ platform: 'win32', environment: {}, home: windowsFixtureHome }), /LOCALAPPDATA|--data-dir/i);
  });

  test('Windows overlap uses components and case-insensitive identity', () => {
    assert.equal(pathsOverlap('C:\\Data\\Skill', 'c:\\data\\skill\\engine', { platform: 'win32' }), true);
    assert.equal(pathsOverlap('C:\\Data\\Skill', 'C:\\Data\\Skill-copy', { platform: 'win32' }), false);
    assert.equal(pathsOverlap('/tmp/data', '/tmp/database', { platform: 'linux' }), false);
  });
  ```

- [ ] **Step 2: Run RED for the absent platform API**

  Run: `node --test test/platform.test.mjs`

  Expected: FAIL because `src/platform.mjs` and its exports do not exist.

- [ ] **Step 3: Implement defaults, component overlap, and local-path rejection**

  Use `path.win32` only for simulated/real Windows paths and `path.posix` for POSIX tests. Normalize with `resolve`, strip only non-root trailing separators, case-fold Windows components, and compare `relative()` rather than string prefixes. Reject Windows `\\server\share`, `\\?\`, `\\.\`, and drive roots whose `DriveInfo.DriveType` is `Network`; reject filesystem roots and home directories at the installer layer, not inside a reusable private-directory function.

  ```js
  export function pathsOverlap(a, b, { platform = process.platform } = {}) {
    const api = platform === 'win32' ? path.win32 : path.posix;
    const normalize = value => platform === 'win32' ? api.resolve(value).toLowerCase() : api.resolve(value);
    const left = normalize(a); const right = normalize(b);
    const within = (parent, child) => {
      const relative = api.relative(parent, child);
      return relative === '' || (!relative.startsWith('..' + api.sep) && relative !== '..' && !api.isAbsolute(relative));
    };
    return within(left, right) || within(right, left);
  }
  ```

- [ ] **Step 4: Add failing native private-storage tests**

  On POSIX, create an owner-only directory/file, prove reads work, broaden the file to `0644`, and prove rejection. On Windows, create through `ensurePrivateDirectory`, write a file, secure it, then use a static PowerShell test command to grant `BUILTIN\\Users` read access and prove `assertPrivateFile` rejects it. Each platform branch must execute on its native CI job; the test reports the current platform in its name and never calls `test.skip()`.

  Also test symlink/junction rejection with a real link when the current OS permits creating it. If Windows runner policy forbids an unprivileged symlink, use a directory junction, which does not require Developer Mode.

- [ ] **Step 5: Run RED for Windows-aware private storage**

  Run: `node --test test/platform.test.mjs test/engine.test.mjs`

  Expected: existing Unix implementation either lacks the new exports or fails the simulated Windows default/overlap tests. The POSIX regression remains green.

- [ ] **Step 6: Implement POSIX and Windows private-storage strategies**

  POSIX retains owner/mode checks and uses `O_NOFOLLOW`. Windows first rejects link/reparse components, checks a local fixed drive, and runs a static PowerShell/.NET program through `powershell.exe -NoLogo -NoProfile -NonInteractive -Command <static-program>` with the target in `COVE_TAROT_ACL_PATH`. The program disables inheritance, replaces explicit rules with FullControl for the current user SID, LocalSystem (`S-1-5-18`), and Builtin Administrators (`S-1-5-32-544`), writes the ACL, then rereads and validates the exact allow identities and protected inheritance. File reads validate the file ACL and regular-file identity before and after opening; errors never include file contents.

  `config.mjs` becomes:

  ```js
  export const defaultDataDir = () => defaultPrivateDataDir();
  export const privateDirectory = directory => ensurePrivateDirectory(directory);
  export const secureFile = filename => readPrivateFile(filename);
  ```

  Config temporary files are created only after the parent directory is secured, then explicitly secured before rename; `loadConfig()` verifies the renamed file again.

- [ ] **Step 7: Verify GREEN and full regression**

  Run: `node --test test/platform.test.mjs test/engine.test.mjs`

  Run: `npm test`

  Expected: all tests pass with no warnings beyond Node's already documented SQLite experimental notice.

- [ ] **Step 8: Commit the platform storage boundary**

  ```bash
  git add src/platform.mjs src/config.mjs test/platform.test.mjs test/engine.test.mjs
  git commit -m "feat: add native private storage boundary"
  ```

### Task 2: Cross-platform installer and safe replacement

**Files:**
- Modify: `src/platform.mjs`
- Modify: `scripts/install.mjs`
- Modify: `test/platform.test.mjs`
- Modify: `test/install.test.mjs`

**Interfaces:**
- `runExternal(command, args, options = {}) -> Promise<{ stdout, stderr }>` invokes real executables without a shell; on Windows only the fixed npm-ci operation uses `cmd.exe` with a constant command string.
- `runNpmCi(cwd, { environment, timeout, maxBuffer } = {}) -> Promise<void>`
- `renameWithRetry(from, to, { platform = process.platform } = {}) -> Promise<void>`
- `removeWithRetry(target, options = {}) -> Promise<void>`
- `assertManagedDestination(target, options = {}) -> Promise<string>` resolves components, rejects links/reparse points and unsupported Windows volumes, and returns the canonical target.

- [ ] **Step 1: Write failing command and retry tests**

  Add a real helper fixture executable whose parent path contains spaces and Unicode. Assert `runExternal(process.execPath, [fixture, 'literal & value'])` receives one literal argument and no shell interpretation. On Windows, assert `runNpmCi` completes in a fixture package whose path contains spaces and `占卜`; on POSIX the same test exercises direct `npm` execution.

  Add a deterministic injected filesystem operation that fails twice with `EPERM` on Windows and then succeeds; assert exactly three attempts. Assert `EACCES`, identity, or validation failures are not retried.

- [ ] **Step 2: Run RED for command and filesystem primitives**

  Run: `node --test test/platform.test.mjs`

  Expected: FAIL because `runExternal`, `runNpmCi`, and retry helpers are missing.

- [ ] **Step 3: Implement minimal command and bounded-retry behavior**

  Directly execute `git` and Node programs with `execFile`. For Windows npm, resolve `ComSpec` and invoke a constant command:

  ```js
  await execFileAsync(environment.ComSpec || 'cmd.exe', [
    '/d', '/s', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund'
  ], { cwd, env: environment, windowsHide: true, timeout, maxBuffer });
  ```

  No user value enters the `/c` string. `cwd` and environment remain separate process options. Retry only `EPERM`, `EBUSY`, and `ENOTEMPTY` for a bounded duration with a short delay; preserve the original error after the limit.

- [ ] **Step 4: Write failing native installer path tests**

  Change the real-Git fixture root to include `space 占卜`. Replace `new URL(...).pathname` with `fileURLToPath()` in spawned-script tests. Add cases for:

  - `Skill` versus `skill` overlap on Windows;
  - `skill` versus `skill-copy` non-overlap;
  - data nested below code and code nested below data;
  - junction/symlink ancestors;
  - UNC/device path rejection on Windows;
  - modified custom artwork surviving failed update and uninstall;
  - failed staged rename leaving current code/config unchanged.

- [ ] **Step 5: Run RED for installer integration**

  Run: `node --test test/install.test.mjs`

  Expected: at least the Unicode fixture or Windows npm/path behavior fails before installer migration.

- [ ] **Step 6: Migrate installer to platform primitives**

  Replace `startsWith` overlap and symlink target checks with canonical relative-component checks. Route Git through `runExternal`, npm through `runNpmCi`, and staging `.git` cleanup and all code switches through bounded platform filesystem helpers. Preserve the unique staging-tree rule: only a path returned by this invocation's `mkdtemp` may be recursively deleted. Keep previous/failed code at sibling recovery paths and never delete user data.

  Snapshot validation accepts Windows npm `.cmd`/`.ps1` bin shims as regular files and POSIX npm symlinks only when their canonical targets remain beneath `engine/node_modules`. Case-fold snapshot identity on Windows and reject ambiguous collisions.

- [ ] **Step 7: Verify GREEN and regression**

  Run: `node --test test/platform.test.mjs test/install.test.mjs`

  Run: `npm test`

  Expected: all tests pass, including real Git install/update/uninstall and modified-artwork retention.

- [ ] **Step 8: Commit installer compatibility**

  ```bash
  git add src/platform.mjs scripts/install.mjs test/platform.test.mjs test/install.test.mjs
  git commit -m "feat: make installer native across desktop platforms"
  ```

### Task 3: Owned process lifecycle, CLI, and database safety

**Files:**
- Modify: `src/platform.mjs`
- Modify: `src/engine.mjs`
- Modify: `scripts/companion.mjs`
- Modify: `test/engine.test.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- `spawnOwned(command, args, options = {}) -> ChildProcess` always uses `shell: false` for Node/engine children and adds `windowsHide: true` on Windows.
- `stopOwnedChild(child, { platform = process.platform, graceMs = 1500 } = {}) -> Promise<void>` acts only on the supplied live child handle.
- `applyPrivateUmask({ platform = process.platform } = {}) -> void` calls `process.umask(0o077)` only on POSIX.
- `assertPrivateDatabaseFiles(dataDir) -> Promise<void>` delegates every existing SQLite/WAL/SHM file to `assertPrivateFile`.

- [ ] **Step 1: Write failing child-lifecycle tests**

  Inject a spawn recorder to prove engine and detached service starts use `windowsHide: true`, `shell: false`, exact argument arrays, and no command strings. Use real Node fixture children for native start/stop/cold-restart. On Windows, assert `stopOwnedChild` ends the held process without a POSIX-signal assumption; on POSIX, retain the graceful-then-forced behavior test. In all cases keep a real unrelated loopback server alive after the engine closes.

- [ ] **Step 2: Run RED for platform-owned process APIs**

  Run: `node --test test/engine.test.mjs test/cli.test.mjs`

  Expected: FAIL because process helpers do not exist and current spawn options omit `windowsHide`.

- [ ] **Step 3: Implement owned process helpers and migrate Engine**

  `spawnOwned` delegates directly to `spawn` with a command and argument array. `stopOwnedChild` first checks the retained handle's `pid`, `exitCode`, and `signalCode`; it subscribes to `exit` before terminating. POSIX sends `SIGTERM`, waits, then sends `SIGKILL` only through the same handle. Windows sends one supported terminating signal through that handle and waits with a bounded timeout; if the handle does not report exit, return a clear owned-child shutdown error rather than invoking `taskkill` on a guessed PID.

  Preserve Engine's startup generation/cancellation, authenticated orphan reuse, and route allowlist unchanged.

- [ ] **Step 4: Add failing native CLI/database tests**

  Replace URL `.pathname` and unconditional `chmod` in tests with `fileURLToPath` and platform private-file helpers. Exercise `doctor`, concurrent `invite`, `events`, and `stop-service` from a real path containing spaces and Chinese characters. On Windows, broaden `state.sqlite` ACL and assert `serve` refuses it; on POSIX retain the `0644` rejection. Assert no credential appears in stdout/stderr.

- [ ] **Step 5: Run RED for CLI migration**

  Run: `node --test test/cli.test.mjs`

  Expected: the native private-database or Windows detached-start assertion fails against current CLI code.

- [ ] **Step 6: Migrate CLI and database checks**

  Use `spawnOwned` for the detached companion service with `detached: true`, `stdio: 'ignore'`, `shell: false`, and Windows hidden-window semantics. Apply umask only through `applyPrivateUmask`. Replace inline `mode`, uid, and symlink checks for SQLite files with `assertPrivateFile`; after `Store` creates SQLite/WAL/SHM files, ensure and verify their native privacy before accepting external requests. Signal listeners remain POSIX-friendly but Windows shutdown does not depend on receiving POSIX signals.

- [ ] **Step 7: Verify GREEN and full lifecycle regression**

  Run: `node --test test/engine.test.mjs test/cli.test.mjs test/install.test.mjs`

  Run: `npm test`

  Expected: all process, cancellation, port ownership, cold restart, CLI paging, and install-lock tests pass.

- [ ] **Step 8: Commit runtime lifecycle compatibility**

  ```bash
  git add src/platform.mjs src/engine.mjs scripts/companion.mjs test/engine.test.mjs test/cli.test.mjs
  git commit -m "feat: support native service lifecycle on Windows"
  ```

### Task 4: Native documentation and four-runner release gates

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `references/host-integration.md`
- Modify: `test/release.test.mjs`
- Modify: `test/browser.test.mjs` only if native path/browser assumptions fail

**Interfaces:**
- CI runner matrix uses `ubuntu-latest` (`x64`), `windows-latest` (`x64`), `macos-15-intel` (`x64`), and `macos-15` (`arm64`).
- Every matrix entry asserts `process.platform` and `process.arch`, installs the exact public engine through `scripts/install.mjs`, runs `npm test`, and executes real Chromium/WebKit UI gates.
- README provides distinct Bash and PowerShell commands with identical lifecycle semantics.

- [ ] **Step 1: Add failing release-behavior tests**

  Extend release tests so a packaged install produced in a Unicode/space directory contains the same CLI, platform module, README, Skill, and engine pin, then run packaged `doctor --help` through `process.execPath`. Verify the package scanner accepts no host absolute path or synthetic credential. Do not grep prose for exact wording; exercise commands exposed by the docs and package.

- [ ] **Step 2: Run RED for packaged platform module**

  Run: `node --test test/release.test.mjs test/install.test.mjs`

  Expected: FAIL if `src/platform.mjs` is not copied or a packaged native command cannot execute.

- [ ] **Step 3: Update bilingual documentation**

  Document Node 24.5+, Git, npm, local WebGL2 browser, and the four supported targets. Provide copy-paste Bash blocks for macOS/Linux and PowerShell blocks using `$env:LOCALAPPDATA`/`Join-Path` for Windows. State explicitly that Windows needs neither WSL nor Git Bash, that private data defaults differ by platform, and that Windows ARM/network data directories/GUI installation are outside this release contract. Preserve provider/DSH/model language verbatim except for platform claims.

- [ ] **Step 4: Build the native CI matrix**

  Convert the workflow to a matrix with explicit expected platform/architecture fields. Use `macos-15-intel` and `macos-15` based on the current GitHub hosted-runner contract. Add:

  ```yaml
  - name: Assert native runner architecture
    run: node -e "if(process.platform!==process.env.EXPECTED_PLATFORM||process.arch!==process.env.EXPECTED_ARCH)process.exit(1)"
    env:
      EXPECTED_PLATFORM: ${{ matrix.platform }}
      EXPECTED_ARCH: ${{ matrix.arch }}
  ```

  Use a Bash install step on Linux/macOS and a PowerShell install step on Windows so paths are passed as quoted native values. Linux installs Playwright system dependencies with `--with-deps`; Windows/macOS install browser binaries without Linux package flags. Set `TAROT_TEST_BROWSER=1` and run `test/browser.test.mjs` on every runner; no matrix platform may treat an unavailable browser as success.

- [ ] **Step 5: Verify local documentation/package regression**

  Run: `npm test`

  Run: `node scripts/check-release.mjs`

  Expected: complete local suite and public-history/content audit pass.

- [ ] **Step 6: Commit docs and release gates**

  ```bash
  git add .github/workflows/test.yml README.md README.en.md references/host-integration.md test/release.test.mjs test/browser.test.mjs
  git commit -m "ci: verify native desktop platforms"
  ```

### Task 5: Public release verification

**Files:**
- Modify only files required by failures reproduced with a new failing test.
- Update: `docs/superpowers/plans/2026-09-01-native-cross-platform-support.md` checkboxes.

**Interfaces:**
- A release is acceptable only when the local macOS suite, public content audit, remote four-runner native matrix, and clean public installation all succeed.

- [ ] **Step 1: Run the local delivery gate from a clean dependency state**

  Run: `npm ci --ignore-scripts --no-audit --no-fund`

  Run: `npm test`

  Run: `node scripts/check-release.mjs`

  Run a clean installation into newly created temporary code/data paths, then run packaged `doctor`, an invitation against the local fake provider/browser flow, `stop-service`, update, and uninstall. Confirm data and custom artwork remain after the applicable operations.

- [ ] **Step 2: Review the complete branch diff**

  Compare against the public base `58f6a7e`. Confirm only platform, test, CI, and documentation files changed; no provider/model/prompt/deck/artwork/invitation-policy behavior changed. Run `git diff --check 58f6a7e...HEAD` and verify the worktree is clean.

- [ ] **Step 3: Push the reviewed branch and observe native CI**

  Push without force. Wait for the workflow and require successful jobs for Ubuntu x64, Windows x64, macOS Intel, and macOS Apple Silicon. A skipped, cancelled, neutral, or timed-out platform job is not success.

- [ ] **Step 4: Fix only reproduced failures with TDD**

  For any remote-only failure, reproduce the platform contract in the narrowest test first, observe RED, implement the minimal fix, rerun the affected native job and the full local suite, then commit. Do not weaken ACL, path, browser, or architecture assertions to make CI green.

- [ ] **Step 5: Verify the public source as a new user**

  Clone the pushed repository into a fresh temporary directory, run the documented install command against the exact public Tarot Ritual pin, run `doctor`, inspect that no personal files or credentials were fetched, then uninstall while preserving data. Confirm GitHub README renders the Windows and POSIX instructions and states the exact support boundary.

- [ ] **Step 6: Finalize plan and release commit state**

  Mark completed checkboxes, run the full delivery gate once more, commit only the plan completion if it is tracked as release evidence, and report commit hashes, CI run link/status, tested platforms, unchanged provider semantics, and any explicit non-goals.

## Plan self-review

- Spec coverage: Tasks 1–3 cover default paths, ACL/mode security, canonical containment, commands, filesystem retry, and owned processes. Task 4 covers user instructions and four native runner/real-browser gates. Task 5 covers release claims, public installation, rollback/data/artwork safety, and remote-only failure discipline.
- Placeholder scan: no TBD/TODO, “similar to,” unspecified validation, or test-after steps remain. Each behavior-changing task begins with an observable failing test and names its expected failure.
- Type consistency: `config.mjs`, installer, engine, and CLI consume only the platform interfaces defined in their task; later tasks do not rename those functions. Existing public exports remain available where current tests/consumers use them.
- Scope discipline: no GUI, updater daemon, Windows ARM guarantee, network-data support, provider change, model change, prompt change, or Tarot UI redesign is included.
