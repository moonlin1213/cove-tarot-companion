#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertRuntime, privateDirectory, loadConfig, writeConfig, defaultDataDir } from '../src/config.mjs';
import { parseArguments, probeService } from './companion.mjs';

const run = promisify(execFile);
const OWNER = '.companion-owned.json';
const SOURCE = 'https://github.com/moonlin1213/tarot-ritual.git';
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
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
  for (const item of [skillDir, dataDir]) {
    if ([path.parse(item).root, os.homedir(), process.cwd(), packageRoot].includes(item) || item.split(path.sep).filter(Boolean).length < 2) throw new Error('Unsafe installation destination');
    let current = path.parse(item).root;
    for (const part of item.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink installation destination is unsafe');
    }
  }
  if (overlap(skillDir, dataDir) || overlap(skillDir, packageRoot)) throw new Error('Code, source and data directories must be separate without overlap');
}
async function snapshot(directory) {
  const entries = {};
  async function walk(current, prefix = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (relative === OWNER) continue;
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(filename);
        if (!relative.startsWith('engine/node_modules/') || !target.startsWith(path.join(directory, 'engine') + path.sep)) throw new Error('Installed code modified with an unsafe symlink');
        entries[relative] = 'symlink:' + await fs.readlink(filename);
      } else if (entry.isDirectory()) { entries[relative + '/'] = 'directory'; await walk(filename, relative + '/'); }
      else if (entry.isFile()) entries[relative] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
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

/** Stage an exact public pin, then atomically switch owned code. Data/config are
 * separate. Old code is retained at a sibling recovery path, never recursively
 * deleted. Snapshots include ignored/untracked assets and installed dependencies.
 */
export async function install({ dataDir = defaultDataDir(), skillDir, packageRoot = packageDirectory, update = false, uninstall = false, environment = process.env }) {
  assertRuntime();
  if (!skillDir) throw new Error('--skill-dir is required');
  skillDir = path.resolve(skillDir); dataDir = path.resolve(dataDir); packageRoot = path.resolve(packageRoot);
  await destination(skillDir, dataDir, packageRoot);
  dataDir = await privateDirectory(dataDir);
  const lockPath = path.join(dataDir, '.install.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { throw new Error('An installation lock already exists; do not run concurrent installs'); }
  let stage; let retainedCode; let switched = false;
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
      retainedCode = skillDir + '.uninstalled-' + randomUUID();
      await fs.rename(skillDir, retainedCode);
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
    stage = await fs.mkdtemp(path.join(path.dirname(skillDir), '.companion-stage-'));
    const engineRoot = path.join(stage, 'engine');
    const commandOptions = { env: environment, timeout: 180000, maxBuffer: 1024 * 1024 };
    try {
      await run('git', ['init', engineRoot], commandOptions);
      await run('git', ['-C', engineRoot, 'remote', 'add', 'origin', SOURCE], commandOptions);
      await run('git', ['-C', engineRoot, 'fetch', '--depth=1', 'origin', manifest.commit], commandOptions);
      await run('git', ['-C', engineRoot, 'checkout', '--detach', 'FETCH_HEAD'], commandOptions);
      const actual = (await run('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], commandOptions)).stdout.trim();
      if (actual !== manifest.commit) throw new Error();
    } catch { throw new Error('Pinned public engine commit is not available or could not be verified; installation unchanged'); }
    if (!await exists(path.join(engineRoot, 'package-lock.json'))) throw new Error('Pinned engine is missing its dependency lockfile');
    // Git metadata is owned staging material, not runtime data or user code.
    await fs.rm(path.join(engineRoot, '.git'), { recursive: true });
    try { await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { ...commandOptions, cwd: engineRoot }); }
    catch { throw new Error('Pinned engine npm ci failed; installation unchanged'); }
    await copyPackage(packageRoot, stage);
    await fs.writeFile(path.join(stage, OWNER), JSON.stringify({ protocol: 'cove-tarot-owned-v1', commit: manifest.commit, files: await snapshot(stage) }), { mode: 0o600, flag: 'wx' });
    // Keep the install lock through both the final occupancy check and switch.
    await requireStoppedEngine(config);
    if (previous) { retainedCode = skillDir + '.previous-' + randomUUID(); await fs.rename(skillDir, retainedCode); }
    try {
      await fs.rename(stage, skillDir); switched = true; stage = null;
      await writeConfig(dataDir, { engineRoot: path.join(skillDir, 'engine') });
    } catch (error) {
      if (switched) { stage = skillDir + '.failed-' + randomUUID(); await fs.rename(skillDir, stage); }
      if (retainedCode) await fs.rename(retainedCode, skillDir);
      throw error;
    }
    return { state: previous ? 'updated' : 'installed', commit: manifest.commit, skillDir, dataDir, ...(retainedCode ? { retainedCode } : {}) };
  } finally {
    // Only a uniquely created staging tree can be recursively removed.
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    await lock.close(); await fs.unlink(lockPath);
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
