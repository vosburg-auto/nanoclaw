/**
 * Fork patch (vosburg-auto): guards the CSPRNG approval-id generator.
 *
 * The v2.1.54 sync reverted both call sites to `Math.random().toString(36)` and
 * the whole suite stayed green, because the only assertion in place was a
 * base64url character-class check — and base36 is a strict subset of base64url.
 * The decoded-byte-length case below is the one Math.random() cannot satisfy.
 */
import { describe, expect, it } from 'vitest';

import { APPROVAL_ID_BYTES, generateApprovalId } from './approval-id.js';

/**
 * Prefix → the button values that card actually ships, read from the producers:
 * `primitive.ts` APPROVAL_OPTIONS (three buttons, incl. REJECT_WITH_REASON_VALUE)
 * and `onecli-approvals.ts` onecliOptions (two buttons). Asserting invented
 * values would either under- or over-constrain the budget.
 */
const CARDS = [
  { prefix: 'ap', values: ['approve', 'reject', 'reject_with_reason'] },
  { prefix: 'oa', values: ['approve', 'reject'] },
] as const;

describe('generateApprovalId', () => {
  it.each(CARDS)('carries $prefix ids with at least 128 bits of entropy', ({ prefix }) => {
    const id = generateApprovalId(prefix);
    expect(id.startsWith(`${prefix}-`)).toBe(true);
    const raw = Buffer.from(id.slice(prefix.length + 1), 'base64url');
    expect(raw.byteLength).toBeGreaterThanOrEqual(16);
    expect(raw.byteLength).toBe(APPROVAL_ID_BYTES);
  });

  it.each(CARDS)('keeps $prefix ids inside the 64-byte callback_data budget', ({ prefix, values }) => {
    // chat:{"a":"<id>","v":"<value>"} — see @chat-adapter/telegram callback encoder.
    const wrap = (id: string, value: string): string => `chat:${JSON.stringify({ a: id, v: value })}`;
    const id = generateApprovalId(prefix);
    for (const value of values) {
      expect(Buffer.byteLength(wrap(id, value), 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('rejects a prefix long enough to overflow the budget', () => {
    // The boundary this module exists to hold: 'appr' (the length the pre-sync
    // fork used with a shorter body) overflows by exactly one byte once the id
    // carries 128 bits. Documents WHY the prefix is 'ap'.
    const wrap = (id: string, value: string): string => `chat:${JSON.stringify({ a: id, v: value })}`;
    const tooLong = generateApprovalId('appr');
    expect(Buffer.byteLength(wrap(tooLong, 'reject_with_reason'), 'utf8')).toBe(65);
  });

  it('produces no collisions over 50,000 samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) seen.add(generateApprovalId('oa'));
    expect(seen.size).toBe(50_000);
  });
});
