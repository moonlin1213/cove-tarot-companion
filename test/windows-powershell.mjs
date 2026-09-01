import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export async function runWindowsPowerShell(program, environment) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program];
  for (const host of ['pwsh.exe', 'powershell.exe']) {
    try {
      await execFile(host, args, { env: environment, windowsHide: true, shell: false });
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('PowerShell 7 or Windows PowerShell is required for Windows ACL regression tests');
}
