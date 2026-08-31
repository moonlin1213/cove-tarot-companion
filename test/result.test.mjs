import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalDraw, buildResult, extractSynthesis } from '../src/result.mjs';

const deck = [
  { id: 'C1', zh: '样例牌甲', en: 'Fixture One', k_up: 'a', k_rev: 'b', up: 'up', rev: 'rev', sym: 'symbol', astro: 'none' },
  { id: 'C2', zh: '样例牌乙', en: 'Fixture Two', k_up: 'c', k_rev: 'd', up: 'up', rev: 'rev', sym: 'symbol', astro: 'none' },
];
const spreads = [{ id: 'pair', zh: '样例牌阵', en: 'Fixture Pair', count: 2, desc: 'Synthetic only', slots: [
  { label: '位置甲', hint: 'hint1', x: 0, y: 0, rot: 0 }, { label: '位置乙', hint: 'hint2', x: 1, y: 0, rot: 0 },
] }];
const catalog = { deck, spreads };
const draws = [{ position: 0, card_id: 'C1', reversed: false, revealed: true },
  { position: 1, card_id: 'C2', reversed: true, revealed: false }];
const session = { id: 'session', conversation_id: 'conversation', revision: 3, phase: 'stopped',
  question: 'Synthetic question', spread_id: 'pair', draws, reading: null };

test('canonical draw takes labels only from original catalog and returns position sorted facts', () => {
  const result = canonicalDraw({ question: 'Question', spread_id: 'pair', draws: [
    { position: 1, card_id: 'C2', reversed: true, zh: 'fabricated' },
    { position: 0, card_id: 'C1', reversed: false, slot: 'fabricated' },
  ] }, catalog);
  assert.equal(result.spread.zh, '样例牌阵');
  assert.deepEqual(result.draws.map(c => [c.position, c.card_id, c.zh, c.en, c.slot, c.reversed]), [
    [0, 'C1', '样例牌甲', 'Fixture One', '位置甲', false], [1, 'C2', '样例牌乙', 'Fixture Two', '位置乙', true],
  ]);
});

test('canonical draw rejects invalid catalog identity, count, position, duplicate cards and orientation', () => {
  for (const payload of [ { spread_id: 'absent', draws }, { spread_id: 'pair', draws: [draws[0]] },
    { spread_id: 'pair', draws: [draws[0], { ...draws[1], position: 0 }] },
    { spread_id: 'pair', draws: [draws[0], { ...draws[1], card_id: 'C1' }] },
    { spread_id: 'pair', draws: [draws[0], { ...draws[1], card_id: 'unknown' }] },
    { spread_id: 'pair', draws: [draws[0], { ...draws[1], reversed: 'yes' }] },
    { spread_id: 'pair', draws: [draws[0], { ...draws[1], position: NaN }] },
  ]) assert.throws(() => canonicalDraw({ question: '', ...payload }, catalog));
});

test('synthesis keeps original sections and qualifications without rewriting or arbitrary tail', () => {
  const text = '### 逐位解读\nNot included\n### 综合信息\n这是倾向，并非保证。\n\n### 建议\n- 先核实。不能替代专业意见。\n### 附录\nDo not include';
  assert.deepEqual(extractSynthesis(text), {
    text: '### 综合信息\n这是倾向，并非保证。\n\n### 建议\n- 先核实。不能替代专业意见。', missing: false,
  });
});

test('fenced or quoted fake headings and arbitrary tail never count as synthesis', () => {
  for (const text of ['No recognized section\nSome arbitrary tail',
    '```markdown\n### 综合信息\nfake\n```\nTail',
    '~~~~\n### 建议\nfake\n~~~~\nTail', '> ### 综合信息\nquoted']) {
    assert.deepEqual(extractSynthesis(text), { text: '', missing: true });
  }
  assert.deepEqual(extractSynthesis('```\n### 综合信息\nfake\n```\n### 建议\nOriginal suggestion'), {
    text: '### 建议\nOriginal suggestion', missing: false,
  });
});

test('genuine heading depths keep subordinate headings and numbered advice qualifications', () => {
  assert.deepEqual(extractSynthesis('## 综合信息\n原句\n### 限定\n仅作参照。\n## 建议\n1. 先核实。\n   不能替代专业意见。\n## 其他\n排除'), {
    text: '## 综合信息\n原句\n### 限定\n仅作参照。\n## 建议\n1. 先核实。\n   不能替代专业意见。', missing: false,
  });
});

test('return exposes only revealed canonical cards and explicitly missing original reading', () => {
  const result = buildResult(session, catalog);
  assert.equal(result.untrusted, true);
  assert.equal(result.protocol, 'cove-tarot-companion-v1');
  assert.equal(result.conversation_id, 'conversation');
  assert.deepEqual(result.source, { engine: 'tarot-ritual' });
  assert.deepEqual(result.cards, [{ position: 0, card_id: 'C1', zh: '样例牌甲', en: 'Fixture One', slot: '位置甲', reversed: false }]);
  assert.equal(result.reading_state, 'missing');
  assert.deepEqual(result.synthesis, { text: '', missing: true, truncated: false });
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes('Fixture Two'), false);
});

test('failed/unknown original reading stays qualified, without claiming completeness', () => {
  const result = buildResult({ ...session, reading: { id: 'attempt', state: 'unknown', text: '### 综合信息\n可能如此，仍待核实。', model: 'model', source: { display: 'Synthetic' } } }, catalog);
  assert.equal(result.reading_state, 'unknown');
  assert.equal(result.reading_id, 'attempt');
  assert.deepEqual(result.source, { engine: 'tarot-ritual', model: 'model', display: 'Synthetic' });
  assert.equal(result.synthesis.text, '### 综合信息\n可能如此，仍待核实。');
  assert.equal(result.synthesis.missing, false);
});

test('serialized JSON bound includes escaping and truthfully marks omitted content', () => {
  const original = '### 综合信息\n' + '"\\\n含义😀'.repeat(1000) + '\n### 建议\n不可省略的限定。';
  const result = buildResult({ ...session, question: '"\\'.repeat(2000),
    reading: { state: 'succeeded', text: original } }, { ...catalog, maxChars: 800 });
  assert.ok(JSON.stringify(result).length <= 800);
  assert.equal(result.truncated, true); assert.equal(result.synthesis.truncated, true);
  assert.equal(result.synthesis.missing, false);
  assert.ok(original.startsWith(result.synthesis.text));
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.synthesis.text));
  assert.equal(JSON.parse(JSON.stringify(result)).untrusted, true);
  assert.throws(() => buildResult(session, { ...catalog, maxChars: NaN }));
  assert.throws(() => buildResult(session, { ...catalog, maxChars: 20 }));
});

test('empty stopped sessions produce missing facts, while invalid revealed facts fail closed', () => {
  assert.deepEqual(buildResult({ ...session, spread_id: null, draws: [] }, catalog).cards, []);
  assert.throws(() => buildResult({ ...session, draws: [{ ...draws[0], card_id: 'unknown' }] }, catalog));
  assert.deepEqual(buildResult({ ...session, draws: [{ ...draws[0], revealed: 'true' }] }, catalog).cards, []);
});

test('all revealed facts survive a tight budget and source URLs cannot enter the result', () => {
  const all = { ...session, draws: draws.map(c => ({ ...c, revealed: true })) };
  const result = buildResult({ ...all, question: 'q'.repeat(4000) }, { ...catalog, maxChars: 1000 });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[1].en, 'Fixture Two');
  assert.equal(result.cards[1].reversed, true);
  assert.ok(JSON.stringify(result).length <= 1000);
  assert.equal(result.truncated, true);
  assert.throws(() => buildResult(all, { ...catalog, maxChars: 256 }), /fit/);
  for (const display of ['mailto:person@example.invalid', 'www.example.invalid/path', 'Synthetic\u001b[31m']) {
    assert.throws(() => buildResult({ ...session, reading: { state: 'failed', text: '', source: { display } } }, catalog), /source/);
  }
});
