import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultPrivateDataDir, ensurePrivateDirectory, readPrivateFile, assertPrivateFile, securePrivateFile } from './platform.mjs';

export const defaultDataDir = () => defaultPrivateDataDir();
export function assertRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error('Node >=24.5.0 is required');
}
export const privateDirectory = directory => ensurePrivateDirectory(directory);
export const secureFile = filename => readPrivateFile(filename);
function validate(config, dataDir) {
  for (const key of ['servicePort', 'enginePort']) {
    if (!Number.isInteger(config[key]) || config[key] < 1024 || config[key] > 65535) throw new Error('Invalid local port configuration');
  }
  if (config.enginePort === config.servicePort) throw new Error('Service and engine ports must differ');
  for (const key of ['adminToken', 'engineToken']) if (!/^[a-f0-9]{64}$/.test(config[key])) throw new Error('Invalid private credential configuration');
  if (!path.isAbsolute(config.engineRoot) || !path.isAbsolute(config.executable)) throw new Error('Absolute engine and executable paths required');
  return { ...config, dataDir, origin: `http://127.0.0.1:${config.servicePort}` };
}
async function privateConfig(filename) {
  const source = await secureFile(filename);
  // JSON parser diagnostics can quote the input, which contains private tokens.
  try { return JSON.parse(source); }
  catch { throw new Error('Invalid private configuration JSON'); }
}
export async function loadConfig(dataDir = defaultDataDir()) {
  assertRuntime();
  dataDir = await privateDirectory(dataDir);
  return validate(await privateConfig(path.join(dataDir, 'config.json')), dataDir);
}
export async function writeConfig(dataDir, changes) {
  assertRuntime();
  dataDir = await privateDirectory(dataDir);
  const filename = path.join(dataDir, 'config.json');
  let prior;
  try { prior = await privateConfig(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = validate({ servicePort: 18642, enginePort: 18643, executable: process.execPath, installationId: randomBytes(16).toString('hex'),
    adminToken: randomBytes(32).toString('hex'), engineToken: randomBytes(32).toString('hex'), ...prior, ...changes }, dataDir);
  delete config.dataDir; delete config.origin;
  const temporary = path.join(dataDir, `.config-${randomBytes(12).toString('hex')}`);
  await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await securePrivateFile(temporary);
    await fs.rename(temporary, filename);
    await assertPrivateFile(filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return loadConfig(dataDir);
}
