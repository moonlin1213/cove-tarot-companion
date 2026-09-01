import test from 'node:test';
import assert from 'node:assert/strict';

test('browser setup diagnostics are bounded fixed codes without route or console secrets', async () => {
  let diagnostics;
  try { diagnostics = await import('./browser-diagnostics.mjs'); } catch { /* RED until the diagnostic helper exists */ }
  assert.equal(typeof diagnostics?.browserDiagnosticCode, 'function', 'the browser gate must classify errors without retaining raw text');
  assert.equal(typeof diagnostics?.formatBrowserSetupDiagnostic, 'function');

  const privateDetail = 'synthetic-private-browser-detail';
  assert.equal(diagnostics.browserDiagnosticCode(`THREE.WebGLRenderer: Error creating WebGL context ${privateDetail}`), 'graphics-context');
  assert.equal(diagnostics.browserDiagnosticCode(`TypeError: failed during boot ${privateDetail}`), 'script-runtime');
  assert.equal(diagnostics.browserDiagnosticCode(`Failed to load module script ${privateDetail}`), 'resource-load');
  assert.equal(diagnostics.browserDiagnosticCode(privateDetail), 'other');

  const output = diagnostics.formatBrowserSetupDiagnostic({
    url: `http://127.0.0.1:18642/ritual/${privateDetail}?token=${privateDetail}`,
    ritualExists: false,
    cardCount: null,
    beginState: 'disabled',
    pageErrorCodes: ['graphics-context', 'script-runtime', privateDetail, 'graphics-context'],
    consoleCodes: ['graphics-context', privateDetail],
  });
  assert.equal(output, 'COVE_BROWSER_SETUP {"location":"/ritual/:id","ritual":"missing","cards":"missing","begin":"disabled","page":["graphics-context","script-runtime","other"],"console":["graphics-context","other"]}');
  assert.ok(Buffer.byteLength(output) <= 512);
  assert.doesNotMatch(output, /synthetic-private-browser-detail|token=|127\.0\.0\.1|18642/);
});
