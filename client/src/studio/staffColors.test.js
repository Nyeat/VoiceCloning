import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_COLORS, addHosts, slotHosts, staffColor } from './staffColors.js';

test('a staff name always gets the same colour, whatever its case or spacing', () => {
  assert.equal(staffColor('Dr Tan'), staffColor('  dr tan '));
  assert.ok(STAFF_COLORS.includes(staffColor('Ms Lee')));
});

test('staff colours never use green or red (those mean free and booked)', () => {
  for (const color of STAFF_COLORS) assert.doesNotMatch(color.dot, /emerald|green|rose|red/u);
});

test('slotHosts reads the list, or splits an older single hostName', () => {
  assert.deepEqual(slotHosts({ hostNames: ['A', 'B'] }), ['A', 'B']);
  assert.deepEqual(slotHosts({ hostName: 'Dr Tan, Ms Lee' }), ['Dr Tan', 'Ms Lee']);
  assert.deepEqual(slotHosts({}), []);
});

test('addHosts trims, skips duplicates in any case, accepts comma lists and caps the count', () => {
  assert.deepEqual(addHosts(['Dr Tan'], ' dr tan , Ms Lee;Mr Ong '), ['Dr Tan', 'Ms Lee', 'Mr Ong']);
  assert.equal(addHosts([], Array.from({ length: 12 }, (_, i) => `S${i}`).join(',')).length, 8);
});
