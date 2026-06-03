import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTENSIBLE_MARKER,
  buildNextMvuData,
  buildSchemaNode,
  collectPresetEntriesFromWorld,
  getCurrentPresetId,
  getPresetFingerprint,
  parseData,
  parseFirstMap,
} from '../dist/mvu-initvar-switcher.core.mjs';

test('parseData accepts JSON inside initvar wrappers and code fences', () => {
  const parsed = parseData('<initvar>\n```json\n{"hero":{"hp":100}}\n```\n</initvar>');
  assert.deepEqual(parsed, { hero: { hp: 100 } });
});

test('preset id priority is inline marker, map, then swipe index', () => {
  assert.equal(getCurrentPresetId({ swipeIndex: 2, text: '<!-- mvu-init-preset:church -->' }, { 2: 'forest' }), 'church');
  assert.equal(getCurrentPresetId({ swipeIndex: 2, text: 'plain opening' }, { 2: 'forest' }), 'forest');
  assert.equal(getCurrentPresetId({ swipeIndex: 2, text: 'plain opening' }, null), '2');
});

test('ValueWithDescription generates schema from the value', () => {
  assert.deepEqual(buildSchemaNode([100, 'Current hit points.']), { type: 'number' });
});

test('replace mode cleans metadata but preserves ValueWithDescription', () => {
  const next = buildNextMvuData({}, {
    player: {
      $meta: { extensible: true },
      hp: [100, 'Current hit points.'],
      inventory: ['candle', EXTENSIBLE_MARKER],
    },
  }, 'replace');

  assert.deepEqual(next.stat_data, {
    player: {
      hp: [100, 'Current hit points.'],
      inventory: ['candle'],
    },
  });
  assert.equal(next.schema?.type, 'object');
});

test('merge mode overlays stat_data and explicit schema', () => {
  const next = buildNextMvuData({
    stat_data: { player: { hp: 50, mp: 10 } },
    schema: { type: 'object', properties: { player: { type: 'object' } } },
  }, {
    stat_data: { player: { hp: 80 } },
    schema: { properties: { player: { required: true } } },
  }, 'merge');

  assert.deepEqual(next.stat_data, { player: { hp: 80, mp: 10 } });
  assert.equal(next.schema?.type, 'object');
});

test('collectPresetEntriesFromWorld and parseFirstMap find presets and maps', () => {
  const presets = [];
  const maps = [];
  collectPresetEntriesFromWorld('book', [
    { name: '[MVU_INIT_PRESET:church]', content: '{"location":"church"}' },
    { name: '[MVU_INIT_MAP]', content: '{"0":"church"}' },
  ], presets, maps);

  assert.equal(presets.length, 1);
  assert.equal(presets[0].id, 'church');
  assert.deepEqual(parseFirstMap(maps), { 0: 'church' });
});

test('preset fingerprint changes when content changes', () => {
  const first = getPresetFingerprint({ id: '0', worldName: 'book', comment: 'a', content: '{"hp":1}' }, 'replace');
  const second = getPresetFingerprint({ id: '0', worldName: 'book', comment: 'a', content: '{"hp":2}' }, 'replace');
  assert.notEqual(first, second);
});
