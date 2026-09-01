import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertLocalPath, assertManagedDestination, assertPrivateFile, defaultPrivateDataDir, ensurePrivateDirectory, pathsOverlap, readPrivateFile, removeWithRetry, renameWithRetry, runExternal, runNpmCi, securePrivateFile } from '../src/platform.mjs';
import { runWindowsPowerShell } from './windows-powershell.mjs';

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

test('local path assertions reject Windows network and device namespaces lexically', async () => {
  for (const candidate of ['\\\\server\\share\\cove', '\\\\?\\C:\\cove', '\\\\.\\PhysicalDrive0']) {
    await assert.rejects(async () => assertLocalPath(candidate, { platform: 'win32' }), /local|network|device/i);
  }
  await assert.doesNotReject(async () => assertLocalPath(path.win32.join(windowsFixtureLocalAppData, 'cove'), { platform: 'win32' }));
});

test('Windows ACL diagnostics expose only fixed stage and reason codes', async () => {
  const platform = await import('../src/platform.mjs');
  assert.equal(typeof platform.windowsAclFailure, 'function', 'the ACL boundary must provide a fixed diagnostic mapper');
  const privateDetail = 'synthetic-private-acl-detail';
  const directory = platform.windowsAclFailure(`${privateDetail}\nCOVE_TAROT_ACL_DIRECTORY_RULE_COUNT`);
  assert.equal(directory.message, 'Private storage ACL or owner is unsafe (ACL_DIRECTORY_RULE_COUNT)');
  assert.doesNotMatch(directory.message, new RegExp(privateDetail));
  const operation = platform.windowsAclFailure(`${privateDetail}\nCOVE_TAROT_ACL_DIRECTORY_UNEXPECTED_ACL_WRITE`);
  assert.equal(operation.message, 'Private storage ACL or owner is unsafe (ACL_DIRECTORY_UNEXPECTED_ACL_WRITE)');
  assert.doesNotMatch(operation.message, new RegExp(privateDetail));
  const exceptionClass = platform.windowsAclFailure(`${privateDetail}\nCOVE_TAROT_ACL_DIRECTORY_UNEXPECTED_ACL_READ_NOT_SUPPORTED`);
  assert.equal(exceptionClass.message, 'Private storage ACL or owner is unsafe (ACL_DIRECTORY_UNEXPECTED_ACL_READ_NOT_SUPPORTED)');
  assert.doesNotMatch(exceptionClass.message, new RegExp(privateDetail));
  const file = platform.windowsAclFailure(`COVE_TAROT_ACL_FILE_VALIDATE_OWNER\n${privateDetail}`);
  assert.equal(file.message, 'Private storage ACL or owner is unsafe (ACL_FILE_VALIDATE_OWNER)');
  const unknown = platform.windowsAclFailure(privateDetail);
  assert.equal(unknown.message, 'Private storage ACL could not be secured or verified');
  assert.doesNotMatch(unknown.message, new RegExp(privateDetail));
});

test('Windows ACL host selection falls back only when an executable is absent', async t => {
  const platform = await import('../src/platform.mjs');
  assert.equal(typeof platform.runWindowsAcl, 'function', 'the ACL boundary must expose an injectable host selector');
  const target = path.win32.join(windowsFixtureLocalAppData, 'cove-tarot-companion');
  const missingHost = () => Object.assign(new Error('host absent'), { code: 'ENOENT' });

  await t.test('prefers pwsh and preserves static argument and environment passing', async () => {
    const calls = [];
    await platform.runWindowsAcl(target, 'secure-directory', { execute: async (host, args, options) => {
      calls.push(host);
      assert.equal(args.at(-1).includes(target), false);
      assert.equal(options.env.COVE_TAROT_ACL_PATH, target);
      assert.equal(options.env.COVE_TAROT_ACL_ACTION, 'secure-directory');
      assert.equal(options.shell, false);
    } });
    assert.deepEqual(calls, ['pwsh.exe']);
  });

  await t.test('uses Windows PowerShell only after pwsh ENOENT', async () => {
    const calls = [];
    await platform.runWindowsAcl(target, 'inspect', { execute: async host => {
      calls.push(host);
      if (host === 'pwsh.exe') throw missingHost();
    } });
    assert.deepEqual(calls, ['pwsh.exe', 'powershell.exe']);
  });

  await t.test('does not fallback after a pwsh command or ACL failure', async () => {
    const calls = [];
    const failure = Object.assign(new Error('fixed failure'), {
      code: 1,
      stderr: 'COVE_TAROT_ACL_DIRECTORY_UNEXPECTED_ACL_READ_COMMAND_MISSING',
    });
    await assert.rejects(platform.runWindowsAcl(target, 'secure-directory', { execute: async host => {
      calls.push(host);
      throw failure;
    } }), /ACL_DIRECTORY_UNEXPECTED_ACL_READ_COMMAND_MISSING/);
    assert.deepEqual(calls, ['pwsh.exe']);
  });

  await t.test('reports a fixed prerequisite error when both hosts are absent', async () => {
    const calls = [];
    await assert.rejects(platform.runWindowsAcl(target, 'inspect', { execute: async host => {
      calls.push(host);
      throw missingHost();
    } }), { message: 'PowerShell 7 or Windows PowerShell is required to verify Windows private storage' });
    assert.deepEqual(calls, ['pwsh.exe', 'powershell.exe']);
  });
});

test('POSIX local-storage classification rejects remote, device and unknown filesystem semantics', async () => {
  const target = path.posix.join(path.posix.sep, 'var', 'tmp', 'companion-fixture');
  const mountInfoImplementation = async () => ({ fileSystem: 'ext4', local: true });
  for (const type of [0x6969n, 0x65735546n, 0x9fa0n, -11317950n]) {
    await assert.rejects(async () => assertLocalPath(target, {
      platform: 'linux',
      statfsImplementation: async () => ({ type }),
      mountInfoImplementation,
    }), /local filesystem|remote|device|reliable/i);
  }
  await assert.rejects(async () => assertLocalPath(target, {
    platform: 'linux',
    statfsImplementation: async () => ({ type: 0x12345678n }),
    mountInfoImplementation: async () => ({ fileSystem: 'syntheticfs', local: true }),
  }), /establish|local filesystem|reliable/i);
  await assert.rejects(async () => assertLocalPath(target, {
    platform: 'darwin',
    statfsImplementation: async () => ({ type: 26n }),
    mountInfoImplementation: async () => ({ fileSystem: 'nfs', local: false }),
  }), /local filesystem|remote|reliable/i);
});

test('known Linux and macOS local filesystems are accepted without weakening unknown-volume failure', async () => {
  const target = path.posix.join(path.posix.sep, 'var', 'tmp', 'companion-fixture');
  await assertLocalPath(target, {
    platform: 'linux',
    statfsImplementation: async () => ({ type: 0xef53n }),
    mountInfoImplementation: async () => { throw new Error('known statfs identity must be sufficient'); },
  });
  await assertLocalPath(target, {
    platform: 'darwin',
    statfsImplementation: async () => ({ type: 26n }),
    mountInfoImplementation: async () => ({ fileSystem: 'apfs', local: true }),
  });
  await assert.rejects(async () => assertLocalPath(target, {
    platform: 'darwin',
    statfsImplementation: async () => ({ type: 26n }),
    mountInfoImplementation: async () => ({ fileSystem: 'syntheticfs', local: true }),
  }), /establish|local filesystem|reliable/i);
});

test(`native fixture storage has verified local filesystem semantics on ${process.platform}`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-local-volume-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assertLocalPath(path.join(root, 'missing-private-data'));
});

test('external commands preserve literal arguments through a Unicode path without a shell', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion command-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixtureDirectory = path.join(root, 'space 占卜');
  const fixture = path.join(fixtureDirectory, 'receive.mjs');
  await fs.mkdir(fixtureDirectory);
  await fs.writeFile(fixture, "process.stdout.write(process.argv[2]);");

  const { stdout } = await runExternal(process.execPath, [fixture, 'literal & value']);
  assert.equal(stdout, 'literal & value');
});

test('npm ci completes in a Unicode working directory without interpolating its path', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion npm-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDirectory = path.join(root, 'space 占卜');
  await fs.mkdir(packageDirectory);
  await fs.writeFile(path.join(packageDirectory, 'package.json'), '{"name":"npm-ci-fixture","version":"1.0.0"}');
  await fs.writeFile(path.join(packageDirectory, 'package-lock.json'), '{"name":"npm-ci-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"npm-ci-fixture","version":"1.0.0"}}}');
  await fs.mkdir(path.join(packageDirectory, 'node_modules'));
  await fs.writeFile(path.join(packageDirectory, 'node_modules', 'must-be-removed'), 'stale');

  await runNpmCi(packageDirectory, { environment: process.env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  await assert.rejects(fs.stat(path.join(packageDirectory, 'node_modules', 'must-be-removed')), { code: 'ENOENT' });
});

test('Windows replacement retries transient sharing failures exactly three times', async () => {
  let attempts = 0;
  await renameWithRetry('from', 'to', {
    platform: 'win32', retryDelay: 0,
    operation: async () => {
      attempts += 1;
      if (attempts < 3) { const error = new Error('busy'); error.code = 'EPERM'; throw error; }
    },
  });
  assert.equal(attempts, 3);
});

test('replacement refuses to retry access and identity failures', async () => {
  for (const code of ['EACCES', 'EINVAL']) {
    let attempts = 0;
    await assert.rejects(renameWithRetry('from', 'to', {
      platform: 'win32', retryDelay: 0,
      operation: async () => { attempts += 1; const error = new Error(code); error.code = code; throw error; },
    }), { code });
    assert.equal(attempts, 1, `${code} must not be retried`);
  }
});

test('Windows lock removal retries a transient busy file without recursive deletion', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion lock-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, '.install.lock'); await fs.writeFile(lock, 'lock');
  let attempts = 0;
  await removeWithRetry(lock, {
    platform: 'win32', retryDelay: 0,
    operation: async () => {
      attempts += 1;
      if (attempts < 3) { const error = new Error('busy'); error.code = 'EBUSY'; throw error; }
      await fs.rm(lock);
    },
  });
  assert.equal(attempts, 3);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('managed destinations reject symlink ancestors and preserve component boundaries', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion destination-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const managed = path.join(root, 'skill');
  await fs.mkdir(managed);
  assert.equal(await assertManagedDestination(managed), managed);
  assert.equal(pathsOverlap(managed, path.join(root, 'skill-copy')), false);
  const link = path.join(root, 'linked-skill');
  await fs.symlink(managed, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertManagedDestination(path.join(link, 'child')), /link|reparse|symlink/i);
});

test(`private storage rejects broad files and links on ${process.platform}`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-platform-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = await ensurePrivateDirectory(path.join(root, 'data'));
  const filename = path.join(directory, 'secret');
  await fs.writeFile(filename, 'synthetic secret', { mode: 0o600 });

  await securePrivateFile(filename);
  assert.equal(await readPrivateFile(filename), 'synthetic secret');
  await assert.doesNotReject(assertPrivateFile(filename));

  if (process.platform === 'win32') {
    const program = "$p=$env:COVE_TAROT_ACL_PATH;$acl=Get-Acl -LiteralPath $p;$sid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545');$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl";
    await runWindowsPowerShell(program, { ...process.env, COVE_TAROT_ACL_PATH: filename });
    await assert.rejects(assertPrivateFile(filename), /ACL|owner|unsafe/i);

    const ownedByOther = path.join(directory, 'foreign-owner');
    await fs.writeFile(ownedByOther, 'synthetic owner test', { mode: 0o600 });
    await securePrivateFile(ownedByOther);
    const replaceOwner = "$p=$env:COVE_TAROT_ACL_PATH;$acl=Get-Acl -LiteralPath $p;$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')));Set-Acl -LiteralPath $p -AclObject $acl";
    await runWindowsPowerShell(replaceOwner, { ...process.env, COVE_TAROT_ACL_PATH: ownedByOther });
    await assert.rejects(assertPrivateFile(ownedByOther), /ACL|owner|unsafe/i);

    const unreadable = path.join(root, 'unreadable-ancestor');
    await fs.mkdir(unreadable);
    const denyAttributes = "$p=$env:COVE_TAROT_ACL_PATH;$acl=Get-Acl -LiteralPath $p;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::ReadAttributes,[Security.AccessControl.AccessControlType]::Deny);$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl";
    const restoreAttributes = "$p=$env:COVE_TAROT_ACL_PATH;$acl=Get-Acl -LiteralPath $p;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::ReadAttributes,[Security.AccessControl.AccessControlType]::Deny);$acl.RemoveAccessRuleAll($rule);Set-Acl -LiteralPath $p -AclObject $acl";
    await runWindowsPowerShell(denyAttributes, { ...process.env, COVE_TAROT_ACL_PATH: unreadable });
    try {
      await assert.rejects(ensurePrivateDirectory(path.join(unreadable, 'child')), /inspect|reparse/i);
    } finally {
      await runWindowsPowerShell(restoreAttributes, { ...process.env, COVE_TAROT_ACL_PATH: unreadable });
    }
  } else {
    await fs.chmod(filename, 0o644);
    await assert.rejects(assertPrivateFile(filename), /private|owner|permission/i);
  }

  const link = path.join(root, 'linked-data');
  await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensurePrivateDirectory(path.join(link, 'nested')), /link|reparse|symlink/i);
});
