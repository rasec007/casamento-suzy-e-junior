import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrazilianPhone, normalizeGuestName } from '../server/guest-match.js';

test('normalizes RSVP names despite accents, spaces, and punctuation', () => {
  assert.equal(normalizeGuestName('  José  & Júlia! '), normalizeGuestName('jose julia'));
  assert.notEqual(normalizeGuestName('Ana Clara'), normalizeGuestName('Ana Claudia'));
});

test('normalizes Brazilian RSVP phone numbers with formatting and country code', () => {
  assert.equal(normalizeBrazilianPhone('+55 (85) 98858-4800'), '85988584800');
  assert.equal(normalizeBrazilianPhone('(85) 98858-4800'), '85988584800');
});
