import test from 'node:test';
import assert from 'node:assert/strict';

test('real browser launch is headed only for WebKit on Intel macOS', async () => {
  let launch;
  try { launch = await import('./browser-launch.mjs'); } catch { /* RED until the launch helper exists */ }
  assert.equal(typeof launch?.browserLaunchOptions, 'function');
  assert.deepEqual(launch.browserLaunchOptions('webkit', { platform: 'darwin', arch: 'x64' }), { headless: false });
  assert.deepEqual(launch.browserLaunchOptions('chromium', { platform: 'darwin', arch: 'x64' }), { headless: true });
  assert.deepEqual(launch.browserLaunchOptions('webkit', { platform: 'darwin', arch: 'arm64' }), { headless: true });
  assert.deepEqual(launch.browserLaunchOptions('webkit', { platform: 'linux', arch: 'x64' }), { headless: true });
});

test('browser acceptance defaults to Chromium and WebKit cases', async () => {
  const launch = await import('./browser-launch.mjs');
  assert.equal(typeof launch.browserAcceptanceCases, 'function');
  assert.deepEqual(launch.browserAcceptanceCases({}), [
    { browserName: 'chromium', mode: 'succeeded' },
    { browserName: 'chromium', mode: 'providerless' },
    { browserName: 'chromium', mode: 'failed' },
    { browserName: 'webkit', mode: 'succeeded' },
    { browserName: 'webkit', mode: 'providerless' },
    { browserName: 'webkit', mode: 'failed' },
  ]);
});

test('explicit Chromium selection constructs no WebKit acceptance cases', async () => {
  const launch = await import('./browser-launch.mjs');
  assert.equal(typeof launch.browserAcceptanceCases, 'function');
  assert.deepEqual(launch.browserAcceptanceCases({ TAROT_TEST_BROWSERS: 'chromium' }), [
    { browserName: 'chromium', mode: 'succeeded' },
    { browserName: 'chromium', mode: 'providerless' },
    { browserName: 'chromium', mode: 'failed' },
  ]);
});
