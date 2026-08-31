const ID = /^[A-Za-z0-9_-]{1,128}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
function boundedText(value, max, field) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`invalid ${field}`);
  return value;
}
function identifier(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`invalid ${field}`);
  return value;
}
function lookupSpread(spreadId, spreads) {
  const spread = spreads.find(s => s.id === spreadId);
  if (!spread || !Number.isSafeInteger(spread.count) || spread.count < 1 || spread.count > 78 || !Array.isArray(spread.slots) || spread.slots.length !== spread.count) fail('invalid spread');
  return spread;
}
function spreadFacts(spread) {
  return { id: identifier(spread.id, 'spread id'), zh: boundedText(spread.zh, 160, 'spread name'), en: boundedText(spread.en, 160, 'spread name') };
}
function cardFacts(draw, deck, spread) {
  if (!draw || !Number.isSafeInteger(draw.position) || draw.position < 0 || draw.position >= spread.count || typeof draw.reversed !== 'boolean') fail('invalid card position or orientation');
  const card = deck.find(c => c.id === draw.card_id);
  if (!card) fail('unknown card');
  return { position: draw.position, card_id: identifier(card.id, 'card id'),
    zh: boundedText(card.zh, 160, 'card name'), en: boundedText(card.en, 160, 'card name'),
    slot: boundedText(spread.slots[draw.position].label, 160, 'slot'), reversed: draw.reversed };
}

/** Validate a complete draw using the original engine's catalog, not UI labels. */
export function canonicalDraw(payload, { deck, spreads }) {
  const question = boundedText(payload.question, 4000, 'question');
  const spread = lookupSpread(identifier(payload.spread_id, 'spread_id'), spreads);
  if (!Array.isArray(payload.draws) || payload.draws.length !== spread.count) fail('invalid draw count');
  const draws = payload.draws.map(draw => cardFacts(draw, deck, spread)).sort((a, b) => a.position - b.position);
  if (draws.some((c, i) => c.position !== i) || new Set(draws.map(c => c.card_id)).size !== draws.length) fail('duplicate cards or positions');
  return { question, spread_id: spread.id, spread: spreadFacts(spread), draws };
}

/** Extract only original synthesis/advice sections. No fallback summary or tail.
 * ATX child headings, lists, and qualifications remain verbatim. Fenced content
 * cannot start/end a section. Missing or empty recognized sections stay missing.
 */
export function extractSynthesis(text) {
  boundedText(text, 1_000_000, 'reading text');
  const lines = text.split('\n');
  const sections = [];
  let start = -1;
  let depth = 0;
  let fence = null;
  const end = index => {
    if (start < 0) return;
    const body = lines.slice(start + 1, index).join('\n').trim();
    if (body) sections.push(lines.slice(start, index).join('\n'));
    start = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = null;
      continue;
    }
    if (fenceMatch) { fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }; continue; }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!heading) continue;
    const level = heading[1].length;
    const title = heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
    const recognized = title === '综合信息' || title === '建议';
    if (start >= 0 && (level <= depth || recognized)) end(i);
    if (recognized) { start = i; depth = level; }
  }
  end(lines.length);
  const extracted = sections.join('\n').trimEnd();
  return { text: extracted, missing: !extracted };
}

function originalSource(reading) {
  const source = { engine: 'tarot-ritual' };
  for (const [key, value] of [['model', reading?.model], ['display', reading?.source?.display]]) {
    if (value === undefined) continue;
    boundedText(value, 160, `source ${key}`);
    if (!value.trim() || /[\u0000-\u001f\u007f]|:\/\/|www\.|\b(?:bearer|api[_-]?key|token|password)\b/i.test(value)) fail('invalid source');
    if (key === 'display' && !/^[\p{L}\p{N} ._()·+-]+$/u.test(value)) fail('invalid source');
    source[key] = value;
  }
  return source;
}
function prefix(value, length) {
  // Never cut a UTF-16 surrogate pair in half.
  if (length > 0 && /[\uD800-\uDBFF]/.test(value[length - 1])) length--;
  return value.slice(0, length);
}

/** JSON.stringify(result).length never exceeds maxChars. Canonical revealed card
 * facts are never dropped; an impossibly small budget fails closed instead.
 * The original complete reading remains exclusively in the local session store.
 */
export function buildResult(session, { deck, spreads, maxChars = 3500 }) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 100_000) fail('invalid maxChars');
  if (!Array.isArray(session.draws) || session.draws.length > 78) fail('invalid draws');
  const revealed = session.draws.filter(draw => draw.revealed === true);
  const spread = session.spread_id == null ? null : lookupSpread(session.spread_id, spreads);
  if (!spread && revealed.length) fail('revealed cards require spread');
  const cards = revealed.map(draw => cardFacts(draw, deck, spread)).sort((a, b) => a.position - b.position);
  if (new Set(cards.map(c => c.position)).size !== cards.length || new Set(cards.map(c => c.card_id)).size !== cards.length) fail('duplicate revealed cards');
  const reading = session.reading;
  const synthesis = extractSynthesis(reading?.text ?? '');
  const result = {
    protocol: 'cove-tarot-companion-v1', type: 'tarot_result', untrusted: true,
    session_id: identifier(session.id, 'session_id'), conversation_id: identifier(session.conversation_id, 'conversation_id'),
    revision: session.revision, phase: session.phase,
    question: boundedText(session.question, 4000, 'question'), spread: spread ? spreadFacts(spread) : null,
    cards, reading_id: reading?.id ?? null, reading_state: reading?.state ?? 'missing', source: originalSource(reading),
    synthesis: { ...synthesis, truncated: false }, truncated: false,
  };
  if (!Number.isSafeInteger(result.revision) || result.revision < 0) fail('invalid revision');
  if (!['accepted', 'drawn', 'revealed', 'returned', 'stopped', 'deleted'].includes(result.phase)) fail('invalid phase');
  if (!['missing', 'running', 'succeeded', 'failed', 'unknown', 'cancelled'].includes(result.reading_state)) fail('invalid reading state');
  if (result.reading_id !== null) identifier(result.reading_id, 'reading_id');
  const size = () => JSON.stringify(result).length;
  if (size() <= maxChars) return result;
  result.truncated = true;
  // Question can be bounded independently; all original card/slot facts survive.
  const question = result.question;
  result.question = '';
  if (size() > maxChars) {
    result.synthesis.truncated = synthesis.text.length > 0;
    result.synthesis.text = '';
    if (size() > maxChars) fail('maxChars cannot fit revealed card facts');
    let lo = 0; let hi = synthesis.text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      result.synthesis.text = prefix(synthesis.text, mid);
      if (size() <= maxChars) lo = mid; else hi = mid - 1;
    }
    result.synthesis.text = prefix(synthesis.text, lo);
  }
  let lo = 0; let hi = question.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    result.question = prefix(question, mid);
    if (size() <= maxChars) lo = mid; else hi = mid - 1;
  }
  result.question = prefix(question, lo);
  return result;
}
