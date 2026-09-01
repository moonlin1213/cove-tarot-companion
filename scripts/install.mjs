#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { assertRuntime, privateDirectory, loadConfig, writeConfig, defaultDataDir } from '../src/config.mjs';
import { assertManagedDestination, pathsOverlap, removeWithRetry, renameWithRetry, runExternal, runNpmCi } from '../src/platform.mjs';
import { parseArguments, probeService } from './companion.mjs';

const OWNER = '.companion-owned.json';
const SOURCE = 'https://github.com/moonlin1213/tarot-ritual.git';
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function requireStoppedEngine(config) {
  if (!config) return;
  const free = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: config.enginePort });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => finish(false));
  });
  if (!free) throw new Error('Engine port is occupied or cannot be verified free; installation unchanged. Stop its known owner or terminal and retry. If no trusted owner remains after a crash, save work and restart the computer before retrying. Never kill a process guessed from its port.');
}
async function destination(skillDir, dataDir, packageRoot) {
  [skillDir, dataDir, packageRoot] = await Promise.all([skillDir, dataDir, packageRoot].map(item => assertManagedDestination(item)));
  const managed = [skillDir, dataDir, packageRoot];
  const unsafe = new Set(await Promise.all([path.parse(skillDir).root, os.homedir(), process.cwd()].map(item => fs.realpath(path.resolve(item)))));
  for (const item of [skillDir, dataDir]) {
    if (unsafe.has(item) || item.split(path.sep).filter(Boolean).length < 2) throw new Error('Unsafe installation destination');
  }
  for (let left = 0; left < managed.length; left += 1) {
    for (let right = left + 1; right < managed.length; right += 1) {
      if (pathsOverlap(managed[left], managed[right])) throw new Error('Code, source and data directories must be separate without overlap');
    }
  }
  return { skillDir, dataDir, packageRoot };
}
async function stableDestination(expected) {
  const actual = await destination(expected.skillDir, expected.dataDir, expected.packageRoot);
  for (const key of ['skillDir', 'dataDir', 'packageRoot']) {
    if (actual[key] !== expected[key]) throw new Error('Installation destination identity changed during validation');
  }
  return actual;
}
function relativeWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep).every(component => component !== '..'));
}
async function snapshot(directory, { platform = process.platform } = {}) {
  const entries = {};
  const addEntry = (relative, value) => {
    const identity = platform === 'win32' ? relative.toLowerCase() : relative;
    if (Object.hasOwn(entries, identity)) throw new Error('Installed code contains an ambiguous case-colliding path');
    entries[identity] = value;
  };
  async function walk(current, prefix = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (relative === OWNER) continue;
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(filename);
        const nodeModules = path.join(directory, 'engine', 'node_modules');
        if (!relativeWithin(nodeModules, filename) || !relativeWithin(nodeModules, target)) throw new Error('Installed code modified with an unsafe symlink');
        addEntry(relative, 'symlink:' + await fs.readlink(filename));
      } else if (entry.isDirectory()) { addEntry(relative + '/', 'directory'); await walk(filename, relative + '/'); }
      else if (entry.isFile()) {
        addEntry(relative, createHash('sha256').update(await fs.readFile(filename)).digest('hex'));
      }
      else throw new Error('Installed code contains an unsafe file type');
    }
  }
  await walk(directory);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}
async function owned(directory) {
  let owner;
  try {
    const stat = await fs.lstat(path.join(directory, OWNER));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    owner = JSON.parse(await fs.readFile(path.join(directory, OWNER), 'utf8'));
    if (owner.protocol !== 'cove-tarot-owned-v1' || !owner.files || !/^[a-f0-9]{40}$/.test(owner.commit)) throw new Error();
  } catch { throw new Error('Destination is not an owned companion installation'); }
  let unchanged = false;
  try { unchanged = JSON.stringify(await snapshot(directory)) === JSON.stringify(owner.files); } catch { /* modifications are preserved */ }
  return { ...owner, unchanged };
}
async function copyPackage(source, target) {
  const files = ['package.json', 'package-lock.json', 'engine-lock.json', 'SKILL.md', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'agents/openai.yaml', 'references/host-integration.md'];
  for (const directory of ['src', 'scripts']) {
    if (!(await fs.lstat(path.join(source, directory))).isDirectory()) throw new Error('Package directories must not be symlinks');
    for (const entry of await fs.readdir(path.join(source, directory), { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(directory + '/' + entry.name);
  }
  files.push('public/invitation.html');
  for (const relative of files) {
    const filename = path.join(source, relative);
    if (!await exists(filename)) continue;
    let current = source;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Package paths must not be symlinks');
    }
    if (!(await fs.lstat(filename)).isFile()) throw new Error('Package files must be regular files');
    await fs.mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await fs.copyFile(filename, path.join(target, relative));
  }
}

function addRecoveryDetails(error, details) {
  if (!details.length) return error;
  error.message += ` Installation recovery incomplete: ${details.join('; ')}.`;
  return error;
}

async function restorePreviousCode({ skillDir, retainedCode, switched, error }) {
  const details = [];
  let failedCode;
  if (switched) {
    const candidate = skillDir + '.failed-' + randomUUID();
    try {
      await renameWithRetry(skillDir, candidate);
      failedCode = candidate;
      details.push(`candidate is retained at ${failedCode}`);
    } catch { details.push(`candidate remains at ${skillDir}`); }
  }
  if (retainedCode) {
    try { await renameWithRetry(retainedCode, skillDir); }
    catch { details.push(`known-good previous code is retained at ${retainedCode}`); }
  }
  return addRecoveryDetails(error, details);
}

/** Stage an exact public pin, then atomically switch owned code. Data/config are
 * separate. Old code is retained at a sibling recovery path, never recursively
 * deleted. Snapshots include ignored/untracked assets and installed dependencies.
 */
export async function install({ dataDir = defaultDataDir(), skillDir, packageRoot = packageDirectory, update = false, uninstall = false, environment = process.env }) {
  assertRuntime();
  if (!skillDir) throw new Error('--skill-dir is required');
  skillDir = path.resolve(skillDir); dataDir = path.resolve(dataDir); packageRoot = path.resolve(packageRoot);
  ({ skillDir, dataDir, packageRoot } = await destination(skillDir, dataDir, packageRoot));
  dataDir = await privateDirectory(dataDir);
  ({ skillDir, dataDir, packageRoot } = await destination(skillDir, dataDir, packageRoot));
  const lockPath = path.join(dataDir, '.install.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { throw new Error('An installation lock already exists; do not run concurrent installs'); }
  let stage; let retainedCode; let switched = false; let primaryError;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    let config;
    try { config = await loadConfig(dataDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const previous = await exists(skillDir) ? await owned(skillDir) : null;
    if (uninstall) {
      if (!previous) return { state: 'not-installed', dataDir };
      if (config && await probeService(config)) throw new Error('Stop the owned service before uninstall');
      if (!previous.unchanged) return { state: 'retained-modified', dataDir, retainedCode: skillDir };
      await requireStoppedEngine(config);
      await stableDestination({ skillDir, dataDir, packageRoot });
      retainedCode = skillDir + '.uninstalled-' + randomUUID();
      await renameWithRetry(skillDir, retainedCode);
      return { state: 'uninstalled', dataDir, retainedCode };
    }
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'engine-lock.json'), 'utf8')); } catch { throw new Error('Missing or invalid engine pin'); }
    if (manifest.repository !== SOURCE || !/^[a-f0-9]{40}$/.test(manifest.commit)) throw new Error('Engine pin requires the public repository and exact 40-character commit');
    if (previous && !previous.unchanged) throw new Error('Installed code is modified; preserve or move it before updating');
    if (previous && !update) {
      if (previous.commit !== manifest.commit) throw new Error('Use --update to switch the engine pin');
      if (!config || config.engineRoot !== path.join(skillDir, 'engine')) throw new Error('Installation config does not match owned code');
      return { state: 'unchanged', commit: previous.commit, dataDir, skillDir };
    }
    if (config && await probeService(config)) throw new Error('Stop the owned service before updating');
    if (config && config.engineRoot !== path.join(skillDir, 'engine')) throw new Error('Existing data directory belongs to another code destination');
    await requireStoppedEngine(config);
    await fs.mkdir(path.dirname(skillDir), { recursive: true });
    ({ skillDir, dataDir, packageRoot } = await destination(skillDir, dataDir, packageRoot));
    stage = await fs.mkdtemp(path.join(path.dirname(skillDir), '.companion-stage-'));
    const engineRoot = path.join(stage, 'engine');
    const commandOptions = { environment, timeout: 180000, maxBuffer: 1024 * 1024 };
    try {
      await runExternal('git', ['init', engineRoot], commandOptions);
      await runExternal('git', ['-C', engineRoot, 'remote', 'add', 'origin', SOURCE], commandOptions);
      await runExternal('git', ['-C', engineRoot, 'fetch', '--depth=1', 'origin', manifest.commit], commandOptions);
      await runExternal('git', ['-C', engineRoot, 'checkout', '--detach', 'FETCH_HEAD'], commandOptions);
      const actual = (await runExternal('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], commandOptions)).stdout.trim();
      if (actual !== manifest.commit) throw new Error();
    } catch { throw new Error('Pinned public engine commit is not available or could not be verified; installation unchanged'); }
    if (!await exists(path.join(engineRoot, 'package-lock.json'))) throw new Error('Pinned engine is missing its dependency lockfile');
    // Git metadata is owned staging material, not runtime data or user code.
    await removeWithRetry(path.join(engineRoot, '.git'), { recursive: true, force: true });
    try { await runNpmCi(engineRoot, commandOptions); }
    catch { throw new Error('Pinned engine npm ci failed; installation unchanged'); }
    await copyPackage(packageRoot, stage);
    await fs.writeFile(path.join(stage, OWNER), JSON.stringify({ protocol: 'cove-tarot-owned-v1', commit: manifest.commit, files: await snapshot(stage) }), { mode: 0o600, flag: 'wx' });
    // Keep the install lock through both the final occupancy check and switch.
    await requireStoppedEngine(config);
    await stableDestination({ skillDir, dataDir, packageRoot });
    if (previous) { retainedCode = skillDir + '.previous-' + randomUUID(); await renameWithRetry(skillDir, retainedCode); }
    try {
      await renameWithRetry(stage, skillDir); switched = true; stage = null;
      if (!config || config.engineRoot !== path.join(skillDir, 'engine')) await writeConfig(dataDir, { engineRoot: path.join(skillDir, 'engine') });
    } catch (error) {
      throw await restorePreviousCode({ skillDir, retainedCode, switched, error });
    }
    return { state: previous ? 'updated' : 'installed', commit: manifest.commit, skillDir, dataDir, ...(retainedCode ? { retainedCode } : {}) };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    try {
      // Only a uniquely created staging tree can be recursively removed.
      if (stage) await removeWithRetry(stage, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
      if (primaryError) addRecoveryDetails(primaryError, [`staging directory retained at ${stage}`]);
    } finally {
      let lockError;
      try { await lock.close(); }
      catch (error) { lockError = error; }
      try { await removeWithRetry(lockPath); }
      catch (error) { lockError ||= error; }
      if (lockError) {
        if (primaryError) addRecoveryDetails(primaryError, [`installer lock retained at ${lockPath}`]);
        else if (!cleanupError) cleanupError = addRecoveryDetails(lockError, [`installer lock retained at ${lockPath}`]);
      }
    }
    if (!primaryError && cleanupError) {
      if (stage) addRecoveryDetails(cleanupError, [`staging directory retained at ${stage}`]);
      throw cleanupError;
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv[2] === 'help') {
    process.stdout.write(`Cove Tarot Companion installer — Node >=24.5.0, Git and npm required
Usage: node scripts/install.mjs --skill-dir DIR [--data-dir DIR] [--update|--uninstall]
Installs the exact public engine pin using npm ci --ignore-scripts.
Stop the owned service before update/uninstall. Code and private data must be
separate. Modified code is preserved; uninstall retains data and recoverable code.
No global installation, startup agent, account import or model request is made.\n`);
  } else {
  const { options, positional } = parseArguments(process.argv.slice(2));
  if (positional.length || Object.keys(options).some(key => !['data-dir', 'skill-dir', 'update', 'uninstall'].includes(key))) throw new Error('Use --data-dir DIR --skill-dir DIR [--update|--uninstall]');
  install({ dataDir: options['data-dir'], skillDir: options['skill-dir'], update: options.update, uninstall: options.uninstall })
    .then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  }
}
