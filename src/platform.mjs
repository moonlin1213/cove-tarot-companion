import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const DATA_DIRECTORY = 'cove-tarot-companion';
const execFile = promisify(execFileCallback);
const TRANSIENT_REPLACEMENT_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const LINUX_LOCAL_FILESYSTEMS = new Set([
  0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x858458f6n,
  0x794c7630n, 0x2fc12fc1n, 0xf2f52010n, 0x24051905n, 0x3153464an,
  0x52654973n,
]);
const LINUX_UNSAFE_FILESYSTEMS = new Set([
  0x6969n, 0xff534d42n, 0x517bn, 0x65735546n, 0x01021997n,
  0x73757245n, 0x5346414fn, 0x00c36400n, 0x0bd00bd0n, 0x564cn,
  0x9fa0n, 0x62656572n, 0x1cd1n, 0x187n,
]);
const LOCAL_FILESYSTEM_NAMES = new Set([
  'apfs', 'hfs', 'ufs', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'tmpfs',
  'ramfs', 'overlay', 'zfs', 'f2fs', 'ubifs', 'jfs', 'reiserfs',
]);
const UNSAFE_FILESYSTEM_NAMES = new Set([
  'nfs', 'nfs4', 'smbfs', 'cifs', 'sshfs', '9p', 'afs', 'ceph', 'coda',
  'davfs', 'glusterfs', 'lustre', 'autofs', 'devfs', 'proc', 'procfs',
  'sysfs', 'devpts', 'fuse', 'fuseblk',
]);
const WINDOWS_ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
function Fail($value, $exitCode) {
  [Console]::Error.WriteLine($value)
  exit $exitCode
}
function ReadAttributes($candidate) {
  try { return [IO.File]::GetAttributes($candidate) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
  catch [UnauthorizedAccessException] { Fail 'COVE_TAROT_ACL_INSPECTION' 25 }
  catch { Fail 'COVE_TAROT_ACL_INSPECTION' 25 }
}
$path = $env:COVE_TAROT_ACL_PATH
try {
  $fullPath = [IO.Path]::GetFullPath($path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  $currentPath = $root
  $attributes = ReadAttributes($root)
  if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'COVE_TAROT_ACL_REPARSE' 21 }
  foreach ($component in $fullPath.Substring($root.Length).Split([char[]]'\\/')) {
    if ($component.Length -eq 0) { continue }
    $currentPath = [IO.Path]::Combine($currentPath, $component)
    $attributes = ReadAttributes($currentPath)
    if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'COVE_TAROT_ACL_REPARSE' 21 }
  }
  $drive = New-Object IO.DriveInfo($root)
  if ($drive.DriveType -eq [IO.DriveType]::Network) { Fail 'COVE_TAROT_ACL_NETWORK' 22 }
  if ($drive.DriveType -eq [IO.DriveType]::Removable) { Fail 'COVE_TAROT_ACL_REMOVABLE' 23 }
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { Fail 'COVE_TAROT_ACL_VOLUME' 24 }
  if ($env:COVE_TAROT_ACL_ACTION -eq 'inspect') { exit 0 }
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $current = $currentSid.Value
  $expected = @($current, 'S-1-5-18', 'S-1-5-32-544')
  if ($env:COVE_TAROT_ACL_ACTION -eq 'secure-directory' -and -not $item.PSIsContainer) { Fail 'COVE_TAROT_ACL_UNSAFE' 24 }
  if (($env:COVE_TAROT_ACL_ACTION -eq 'secure-file' -or $env:COVE_TAROT_ACL_ACTION -eq 'validate-file') -and $item.PSIsContainer) { Fail 'COVE_TAROT_ACL_UNSAFE' 24 }
  if ($env:COVE_TAROT_ACL_ACTION -like 'secure-*') {
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    if ($item.PSIsContainer) {
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($identity in $expected) {
      $sid = New-Object Security.Principal.SecurityIdentifier($identity)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      [void]$acl.AddAccessRule($rule)
    }
    $acl.SetOwner($currentSid)
    Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  }
  if (-not $acl.AreAccessRulesProtected) { Fail 'COVE_TAROT_ACL_UNSAFE' 24 }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current) { Fail 'COVE_TAROT_ACL_OWNER' 24 }
  $rules = @($acl.Access | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })
  if ($rules.Count -ne 3) { Fail 'COVE_TAROT_ACL_UNSAFE' 24 }
  foreach ($identity in $expected) {
    $rule = @($rules | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $identity })
    if ($rule.Count -ne 1 -or (($rule[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { Fail 'COVE_TAROT_ACL_UNSAFE' 24 }
  }
} catch {
  Fail 'COVE_TAROT_ACL_UNSAFE' 24
}
`;

export function isPosix({ platform = process.platform } = {}) {
  return platform !== 'win32';
}

export function applyPrivateUmask({ platform = process.platform } = {}) {
  if (isPosix({ platform })) process.umask(0o077);
}

export function defaultPrivateDataDir({ platform = process.platform, environment = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    if (!environment.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required on Windows; specify --data-dir with a private local directory');
    return path.win32.join(environment.LOCALAPPDATA, DATA_DIRECTORY);
  }
  return path.posix.join(home, '.local', 'share', DATA_DIRECTORY);
}

export function pathsOverlap(left, right, { platform = process.platform } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => platform === 'win32' ? api.resolve(value).toLowerCase() : api.resolve(value);
  const first = normalize(left);
  const second = normalize(right);
  const within = (parent, child) => {
    const relative = api.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + api.sep) && relative !== '..' && !api.isAbsolute(relative));
  };
  return within(first, second) || within(second, first);
}

/** Execute a program directly.  Arguments and working directories never pass
 * through a command interpreter. */
export async function runExternal(command, args, { environment = process.env, ...options } = {}) {
  return execFile(command, args, { ...options, env: environment, shell: false, windowsHide: true });
}

/** Start a process owned by this invocation without passing its command or
 * arguments through a shell. */
export function spawnOwned(command, args, {
  platform = process.platform,
  spawnImplementation = spawn,
  ...options
} = {}) {
  if (!Array.isArray(args)) throw new TypeError('Owned process arguments must be an array');
  return spawnImplementation(command, args, {
    ...options,
    shell: false,
    ...(platform === 'win32' ? { windowsHide: true } : {}),
  });
}

function childIsLive(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
}

/** Stop only the retained child handle.  Failure to observe exit is explicit;
 * callers must never substitute a PID or port lookup. */
export async function stopOwnedChild(child, { platform = process.platform, graceMs = 1500 } = {}) {
  if (!childIsLive(child)) return;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError('Owned child grace period must be non-negative');

  let onExit;
  const exited = new Promise(resolve => {
    onExit = () => resolve(true);
    child.once('exit', onExit);
  });
  const waitForExit = async () => {
    if (!childIsLive(child)) return true;
    let timer;
    try {
      return await Promise.race([
        exited,
        new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };

  try {
    if (platform === 'win32') {
      child.kill();
      if (!await waitForExit()) throw new Error('Owned child shutdown timed out before exit could be verified');
      return;
    }

    child.kill('SIGTERM');
    if (await waitForExit()) return;
    child.kill('SIGKILL');
    if (!await waitForExit()) throw new Error('Owned child did not exit after forced shutdown');
  } finally {
    child.off('exit', onExit);
  }
}

/** Install a pinned engine lockfile without interpreting an installation path. */
export async function runNpmCi(cwd, { environment = process.env, timeout, maxBuffer, platform = process.platform } = {}) {
  const options = { cwd, env: environment, timeout, maxBuffer, windowsHide: true };
  if (platform === 'win32') {
    await execFile(environment.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund'], options);
  } else {
    await runExternal('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { environment, cwd, timeout, maxBuffer });
  }
}

async function retryReplacement(operation, { platform = process.platform, retryDelay = 50, timeout = 1_500, maxAttempts = 5 } = {}) {
  let original;
  const deadline = Date.now() + timeout;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (!original) original = error;
      if (platform !== 'win32' || !TRANSIENT_REPLACEMENT_ERRORS.has(error?.code) || attempt + 1 >= maxAttempts || Date.now() >= deadline) throw original;
      if (retryDelay) await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  throw original;
}

/** Retry only the short-lived Windows sharing failures that commonly block a
 * directory swap; access, identity, and validation failures fail closed. */
export async function renameWithRetry(from, to, { operation = () => fs.rename(from, to), ...options } = {}) {
  return retryReplacement(operation, options);
}

/** Callers may use recursive removal only for a staging tree created during this invocation. */
export async function removeWithRetry(target, { recursive = false, force = false, operation = () => fs.rm(target, { recursive, force }), ...options } = {}) {
  return retryReplacement(operation, options);
}

function nativePath(target, platform) {
  if (typeof target !== 'string' || target.length === 0) throw new Error('A local path is required');
  if (platform === 'win32' && (/^[\\/]{2}[?.][\\/]/.test(target) || /^[\\/]{2}/.test(target))) {
    throw new Error('Private storage requires a local path, not a network or device namespace');
  }
  const api = platform === 'win32' ? path.win32 : path.posix;
  const resolved = api.resolve(target);
  if (!api.isAbsolute(resolved)) throw new Error('Private storage requires an absolute local path');
  return resolved;
}

function filesystemType(value) {
  try { return BigInt.asUintN(32, BigInt(value)); }
  catch { throw new Error('Private storage filesystem semantics could not be established'); }
}

function unescapeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(Number.parseInt(digits, 8)));
}

function pathContains(parent, child, api = path.posix) {
  const relative = api.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + api.sep) && relative !== '..' && !api.isAbsolute(relative));
}

function deepestMount(target, entries) {
  return entries.filter(entry => pathContains(entry.mountPoint, target)).sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
}

async function nativeMountInfo(target, { platform }) {
  if (platform === 'linux') {
    const source = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const entries = [];
    for (const line of source.split('\n')) {
      const divider = line.indexOf(' - ');
      if (divider < 0) continue;
      const before = line.slice(0, divider).split(' ');
      const after = line.slice(divider + 3).split(' ');
      if (before.length < 6 || after.length < 1) continue;
      entries.push({
        mountPoint: unescapeMountPath(before[4]),
        fileSystem: after[0].toLowerCase(),
        local: !UNSAFE_FILESYSTEM_NAMES.has(after[0].toLowerCase()) && !after[0].toLowerCase().startsWith('fuse.'),
      });
    }
    return deepestMount(target, entries);
  }
  if (platform === 'darwin') {
    const { stdout } = await execFile('/sbin/mount', [], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const entries = [];
    for (const line of stdout.split('\n')) {
      const match = /^.+ on (.+) \(([^)]+)\)$/.exec(line);
      if (!match) continue;
      const values = match[2].split(',').map(value => value.trim().toLowerCase());
      entries.push({ mountPoint: unescapeMountPath(match[1]), fileSystem: values[0], local: values.includes('local') });
    }
    return deepestMount(target, entries);
  }
  return null;
}

async function existingAncestor(target, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  let current = target;
  while (true) {
    try { await fs.lstat(current); return current; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = api.dirname(current);
      if (parent === current) throw new Error('Private storage filesystem semantics could not be established');
      current = parent;
    }
  }
}

/** Reject namespaces and volumes whose local replacement and locking semantics
 * cannot be established before any private storage operation. */
export async function assertLocalPath(target, {
  platform = process.platform,
  statfsImplementation = fs.statfs,
  mountInfoImplementation = nativeMountInfo,
} = {}) {
  const resolved = nativePath(target, platform);
  if (platform === 'win32') return resolved;
  if (platform !== 'linux' && platform !== 'darwin') throw new Error('Private storage filesystem semantics could not be established on this platform');
  const existing = await existingAncestor(resolved, platform);
  let stat;
  try { stat = await statfsImplementation(existing, { bigint: true }); }
  catch { throw new Error('Private storage filesystem semantics could not be established'); }
  const type = filesystemType(stat?.type);
  if (platform === 'linux' && LINUX_UNSAFE_FILESYSTEMS.has(type)) {
    throw new Error('Private storage requires a reliable local filesystem, not a remote, device or synthetic filesystem');
  }
  if (platform === 'linux' && LINUX_LOCAL_FILESYSTEMS.has(type)) return resolved;
  let mount;
  try { mount = await mountInfoImplementation(existing, { platform }); }
  catch { throw new Error('Private storage filesystem semantics could not be established'); }
  const name = String(mount?.fileSystem || '').toLowerCase();
  if (!mount || mount.local !== true || UNSAFE_FILESYSTEM_NAMES.has(name) || name.startsWith('fuse.')) {
    throw new Error('Private storage requires a reliable local filesystem, not a remote, device or synthetic filesystem');
  }
  if (!LOCAL_FILESYSTEM_NAMES.has(name)) throw new Error('Private storage filesystem semantics could not be established');
  return resolved;
}

function identifier(stat) {
  return `${stat.dev}:${stat.ino}`;
}

async function assertNoLinks(target, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = api.parse(target).root;
  const components = api.relative(root, target).split(api.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = api.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symlink or reparse-point private storage is unsafe');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

/** Resolve a managed installation path without following symlink/reparse-point
 * ancestors.  The returned name is canonical for every existing component. */
export async function assertManagedDestination(target, options = {}) {
  const { platform = process.platform } = options;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const resolved = nativePath(target, platform);
  await assertLocalPath(resolved, options);
  if (platform === 'win32') await windowsAcl(resolved, 'inspect');
  await assertNoLinks(resolved, platform);

  const missing = [];
  let existing = resolved;
  while (true) {
    try {
      const stat = await fs.lstat(existing);
      if (stat.isSymbolicLink()) throw new Error('Symlink or reparse-point installation destination is unsafe');
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = api.dirname(existing);
      if (parent === existing) throw new Error('Installation destination could not be resolved safely');
      missing.unshift(api.basename(existing));
      existing = parent;
    }
  }
  const canonical = await fs.realpath(existing);
  return api.join(canonical, ...missing);
}

async function assertPosixDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Data directory must have private owner-only permissions');
  }
}

async function assertPosixFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Secret file must have private owner-only permissions');
  }
  return stat;
}

async function windowsAcl(filename, action) {
  try {
    await execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_PROGRAM], {
      env: { ...process.env, COVE_TAROT_ACL_PATH: filename, COVE_TAROT_ACL_ACTION: action },
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('PowerShell is required to verify Windows private storage');
    const category = /COVE_TAROT_ACL_(REPARSE|NETWORK|REMOVABLE|VOLUME|OWNER|UNSAFE|INSPECTION)/.exec(String(error?.stderr || ''))?.[1];
    if (category === 'REPARSE') throw new Error('Private storage path contains a reparse point');
    if (category === 'INSPECTION') throw new Error('Private storage path could not be inspected safely');
    if (category === 'NETWORK') throw new Error('Private storage is on a network volume; choose a local fixed --data-dir');
    if (category === 'REMOVABLE' || category === 'VOLUME') throw new Error('Private storage must use a local fixed --data-dir');
    if (category === 'OWNER' || category === 'UNSAFE') throw new Error('Private storage ACL or owner is unsafe');
    throw new Error('Private storage ACL could not be secured or verified');
  }
}

export async function ensurePrivateDirectory(directory, options = {}) {
  const { platform = process.platform } = options;
  directory = nativePath(directory, platform);
  await assertLocalPath(directory, options);
  if (platform === 'win32') await windowsAcl(directory, 'inspect');
  else await assertNoLinks(directory, platform);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    await windowsAcl(directory, 'secure-directory');
  } else {
    await assertNoLinks(directory, platform);
    await fs.chmod(directory, 0o700);
    await assertPosixDirectory(directory);
  }
  return directory;
}

async function openPrivateFile(filename, options = {}) {
  const { platform = process.platform } = options;
  filename = nativePath(filename, platform);
  await assertLocalPath(filename, options);
  let before;
  if (platform === 'win32') {
    await windowsAcl(filename, 'inspect');
    before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Secret must be a regular file, not a link');
    await windowsAcl(filename, 'validate-file');
  } else {
    await assertNoLinks(filename, platform);
    before = await assertPosixFile(filename);
  }
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = await file.stat();
  if (!opened.isFile() || identifier(opened) !== identifier(before)) {
    await file.close();
    throw new Error('Secret changed while being opened');
  }
  return { file, filename, before, platform };
}

async function verifyPrivateFileAfterOpen({ file, filename, before, platform }) {
  const after = await fs.lstat(filename);
  if (!after.isFile() || after.isSymbolicLink() || identifier(after) !== identifier(before)) throw new Error('Secret changed while being read');
  if (platform === 'win32') await windowsAcl(filename, 'validate-file');
  else await assertPosixFile(filename);
  await file.stat();
}

export async function assertPrivateFile(filename, options = {}) {
  const opened = await openPrivateFile(filename, options);
  try { await verifyPrivateFileAfterOpen(opened); } finally { await opened.file.close(); }
}

export async function assertPrivateDatabaseFiles(dataDir) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { await assertPrivateFile(path.join(dataDir, 'state.sqlite' + suffix)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

/** Explicitly harden a newly-created sensitive file after its parent is private. */
export async function securePrivateFile(filename, options = {}) {
  const { platform = process.platform } = options;
  filename = nativePath(filename, platform);
  await assertLocalPath(filename, options);
  if (platform === 'win32') await windowsAcl(filename, 'inspect');
  else await assertNoLinks(filename, platform);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Secret must be a regular file, not a link');
  if (platform === 'win32') await windowsAcl(filename, 'secure-file');
  else await fs.chmod(filename, 0o600);
  await assertPrivateFile(filename, { platform });
}

export async function readPrivateFile(filename, options = {}) {
  const opened = await openPrivateFile(filename, options);
  try {
    const content = await opened.file.readFile('utf8');
    await verifyPrivateFileAfterOpen(opened);
    return content;
  } finally { await opened.file.close(); }
}
