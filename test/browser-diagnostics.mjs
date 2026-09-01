const CODES = new Set(['graphics-context', 'resource-load', 'script-runtime', 'other']);

export function browserDiagnosticCode(value) {
  const text = String(value || '').toLowerCase();
  if (/webgl|graphics context|gpu context|gl context/.test(text)) return 'graphics-context';
  if (/failed to load|load failed|module script|network|resource/.test(text)) return 'resource-load';
  if (/syntaxerror|referenceerror|typeerror|rangeerror|evalerror/.test(text)) return 'script-runtime';
  return 'other';
}

function fixedCodes(values) {
  const result = [];
  for (const value of values || []) {
    const code = CODES.has(value) ? value : 'other';
    if (!result.includes(code)) result.push(code);
    if (result.length === 4) break;
  }
  return result;
}

export function formatBrowserSetupDiagnostic({ url, ritualExists, cardCount, beginState, pageErrorCodes, consoleCodes } = {}) {
  let location = 'unexpected';
  try { if (/^\/ritual\/[^/]+\/?$/.test(new URL(url).pathname)) location = '/ritual/:id'; } catch { /* fixed fallback */ }
  const cards = Number.isInteger(cardCount) && cardCount >= 0 ? cardCount : 'missing';
  const begin = ['missing', 'disabled', 'enabled'].includes(beginState) ? beginState : 'unknown';
  return 'COVE_BROWSER_SETUP ' + JSON.stringify({
    location,
    ritual: ritualExists === true ? 'present' : 'missing',
    cards,
    begin,
    page: fixedCodes(pageErrorCodes),
    console: fixedCodes(consoleCodes),
  });
}
