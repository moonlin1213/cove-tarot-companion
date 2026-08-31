#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SOURCE = 'https://github.com/moonlin1213/tarot-ritual.git';
const PUBLIC_URLS = new Set([SOURCE, SOURCE.replace(/\.git$/, ''),
  'https://github.com/moonlin1213/cove-tarot-companion.git', 'https://github.com/moonlin1213/cove-tarot-companion']);
const NAME = 'Cove Contributors';
const EMAIL = 'contributors@users.noreply.github.com';
const PRIVATE_FILE = /(?:^|\/)(?:\.env(?:\..+)?|config\.json|[^/]*\.sqlite(?:-wal|-shm)?|[^/]*\.log|\.superpowers(?:\/|$)|\.DS_Store$)/;
const RULES = [
  ['credential', /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['private-path', /(?:\/(?:Users|home)\/[^\s/"'`]+\/|[A-Za-z]:\\Users\\[^\s\\"'`]+\\)/],
  ['private-network', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
];

/** Scan working tracked files, the index, every selected historical blob and
 * author/committer metadata. Findings identify locations/rules, never values.
 * Caller-specific private terms remain outside the repository. This is a gate,
 * not a proof that arbitrary personal data or artwork can be recognized by regex.
 */
export async function checkRelease({ cwd = process.cwd(), privateTerms = [], expectedCommit, base } = {}) {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const findings = []; const seen = new Set(); const blobIds = new Set();
  const add = (rule, location) => {
    const key = rule + '\0' + location;
    if (!seen.has(key)) { seen.add(key); findings.push({ rule, location }); }
  };
  const terms = privateTerms.filter(x => typeof x === 'string' && x.length).map(x => x.toLowerCase());
  const scan = (text, location) => {
    for (const [rule, pattern] of RULES) if (pattern.test(text)) add(rule, location);
    const assignments = text.matchAll(/\b(?:api[_-]?key|adminToken|engineToken|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{16,})["']/gi);
    for (const match of assignments) if (!/^synthetic[-_]/i.test(match[1])) add('credential', location);
    const privateText = text.replace(/https?:\/\/[^\s"'<>`\]\[)]+/g, url => PUBLIC_URLS.has(url) ? '' : url);
    if (terms.some(term => privateText.toLowerCase().includes(term))) add('private-term', location);
  };
  const checkPath = (name, location, mode) => {
    if (PRIVATE_FILE.test(name)) add('private-file', location);
    if (mode === '120000') add('symlink', location);
    scan(name, location);
  };
  const checkLock = (text, location, expected) => {
    try {
      const lock = JSON.parse(text);
      if (lock.repository !== SOURCE || !/^[a-f0-9]{40}$/.test(lock.commit) || (expected && lock.commit !== expected)) throw new Error();
      return { repository: lock.repository, commit: lock.commit };
    } catch { add('engine-lock', location); return null; }
  };
  const blob = (sha, location) => {
    blobIds.add(sha);
    const text = git('cat-file', 'blob', sha);
    scan(text, location);
    return text;
  };
  // Do not print a path supplied by private content or a caller's private terms.
  // Ordinal locations can be resolved privately with git ls-files/ls-tree.
  const tracked = git('ls-files', '-s', '-z').split('\0').filter(Boolean);
  let indexLock = null;
  for (let i = 0; i < tracked.length; i++) {
    const record = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(tracked[i]);
    if (!record) throw new Error('Cannot parse tracked index');
    const [, mode, sha, stage, name] = record;
    const location = `index:${i + 1}`;
    checkPath(name, location, mode);
    const text = blob(sha, location);
    if (name === 'engine-lock.json' && stage === '0' && ['100644', '100755'].includes(mode)) indexLock = checkLock(text, location, expectedCommit);
    if (stage !== '0') add('unmerged-index', location);
    try {
      const stat = await fs.lstat(path.join(cwd, name));
      if (stat.isSymbolicLink()) add('symlink', `working:${i + 1}`);
      else if (stat.isFile()) scan(await fs.readFile(path.join(cwd, name), 'utf8'), `working:${i + 1}`);
      else add('nonregular-file', `working:${i + 1}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!indexLock) add('engine-lock', 'index:engine-lock');
  // HEAD is still the publishable commit when an explicit base excludes it.
  // Older exact pins are allowed; expectedCommit describes the staged release.
  try { checkLock(git('show', 'HEAD:engine-lock.json'), 'HEAD:engine-lock'); }
  catch { add('engine-lock', 'HEAD:engine-lock'); }
  if (base && !/^[a-f0-9]{40}$/.test(base)) throw new Error('Base must be an exact commit');
  const commits = git('rev-list', base ? `${base}..HEAD` : 'HEAD').trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const [author, authorEmail, committer, committerEmail, message] = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', commit).split('\0');
    if (author !== NAME || authorEmail !== EMAIL || committer !== NAME || committerEmail !== EMAIL) add('commit-identity', `commit:${commit}`);
    scan([author, authorEmail, committer, committerEmail, message].join('\n'), `commit:${commit}`);
    const entries = git('ls-tree', '-rz', commit).split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entries[i]);
      if (!match) throw new Error('Cannot parse commit tree');
      const [, mode, type, sha, name] = match; const location = `history:${commit}:${i + 1}`;
      checkPath(name, location, mode);
      if (type !== 'blob') add('non-blob-entry', location);
      else {
        const text = blob(sha, location);
        if (name === 'engine-lock.json') checkLock(text, location);
      }
    }
  }
  try {
    const filename = path.join(cwd, 'engine-lock.json');
    if (!(await fs.lstat(filename)).isFile()) throw new Error();
    const lock = checkLock(await fs.readFile(filename, 'utf8'), 'engine-lock', expectedCommit);
    if (JSON.stringify(lock) !== JSON.stringify(indexLock)) add('engine-lock', 'working-index:engine-lock');
  } catch { add('engine-lock', 'engine-lock'); }
  return { ok: !findings.length, commits: commits.length, blobs: blobIds.size, tracked: tracked.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/check-release.mjs [--base EXACT_SHA] [--expected-engine EXACT_SHA]\nScans tracked working/index files and full HEAD history (or base..HEAD).\nOptional RELEASE_PRIVATE_TERMS is a JSON array supplied privately via environment.\nDoes not audit untracked artifacts, arbitrary artwork or remote availability.\n');
  } else {
    try {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!['--base', '--expected-engine'].includes(args[i]) || !/^[a-f0-9]{40}$/.test(args[i + 1] || '')) throw new Error('Invalid checker arguments');
        options[args[i] === '--base' ? 'base' : 'expectedCommit'] = args[i + 1];
      }
      const terms = JSON.parse(process.env.RELEASE_PRIVATE_TERMS || '[]');
      if (!Array.isArray(terms) || terms.some(x => typeof x !== 'string')) throw new Error();
      const result = await checkRelease({ ...options, privateTerms: terms });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.ok ? 0 : 1;
    } catch { process.stderr.write('Release check could not complete; inspect configuration privately.\n'); process.exitCode = 1; }
  }
}
