export function browserLaunchOptions(browserName, { platform = process.platform, arch = process.arch } = {}) {
  const headedIntelWebKit = browserName === 'webkit' && platform === 'darwin' && arch === 'x64';
  return { headless: !headedIntelWebKit };
}

export function browserAcceptanceCases(environment = process.env) {
  const browserNames = (environment.TAROT_TEST_BROWSERS ?? 'chromium,webkit').split(',');
  const allowed = new Set(['chromium', 'webkit']);
  if (browserNames.length === 0 || browserNames.some(name => !allowed.has(name)) || new Set(browserNames).size !== browserNames.length) {
    throw new Error('Invalid browser acceptance selection');
  }
  return browserNames.flatMap(browserName => ['succeeded', 'providerless', 'failed'].map(mode => ({ browserName, mode })));
}
