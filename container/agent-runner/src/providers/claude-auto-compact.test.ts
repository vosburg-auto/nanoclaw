/**
 * Precedence tests for the per-group auto-compact window
 * (resolveAutoCompactWindow in providers/claude.ts):
 * per-group config > CLAUDE_CODE_AUTO_COMPACT_WINDOW env override > built-in
 * 165000 default. The env fallback is injected as a parameter so the logic is
 * testable without reloading the module or mutating process.env (module-level
 * env capture happens once at import).
 */
import { describe, expect, it } from 'bun:test';

import { resolveAutoCompactWindow } from './claude.js';

describe('resolveAutoCompactWindow', () => {
  it('per-group config wins over the env override', () => {
    expect(resolveAutoCompactWindow(450000, '200000')).toBe('450000');
  });

  it('env override wins when no per-group value is configured', () => {
    expect(resolveAutoCompactWindow(undefined, '200000')).toBe('200000');
  });

  it('falls back to the built-in default when neither is set', () => {
    // In a test env without CLAUDE_CODE_AUTO_COMPACT_WINDOW exported, the
    // module-level default parameter resolves to the built-in constant.
    const expected = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';
    expect(resolveAutoCompactWindow(undefined)).toBe(expected);
  });
});
