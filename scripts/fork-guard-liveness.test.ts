/**
 * Tests for the guard-liveness checker's decision logic.
 *
 * The script's job is to decide, mechanically, whether a fork patch's guard can
 * actually fail. Its two decisions — which patches to check, and what a
 * before/after pair means — are pure, and are what this file pins. The
 * tree-mutating loop around them is not unit-tested: stubbing git and the
 * filesystem there would assert the stub, and the loop's real safety properties
 * (refuses a dirty tree, restores on every exit path) are integration concerns.
 *
 * `classify` is worth testing out of proportion to its size. Getting it backwards
 * inverts the script's entire verdict — every inert guard would report as live,
 * which is precisely the "reports safety it does not provide" failure the script
 * exists to catch, reintroduced one level up.
 *
 * Filename note: this path does not exist upstream, so a sync cannot delete it
 * along with the feature.
 */
import { describe, expect, it } from 'vitest';

import { classify, parseArgs, selectTargets } from './fork-guard-liveness.mjs';

type Patch = { path: string; status: string; guard?: string; guard_waiver?: string };

const manifestOf = (...patches: Patch[]) => ({ patches });

describe('classify', () => {
  it('calls a guard that fails on a clean tree BROKEN', () => {
    expect(classify({ beforeOk: false, afterOk: false })).toBe('broken');
    // Broken dominates: if the baseline fails, the after-result is meaningless.
    expect(classify({ beforeOk: false, afterOk: true })).toBe('broken');
  });

  it('calls a guard that still passes after the revert INERT', () => {
    expect(classify({ beforeOk: true, afterOk: true })).toBe('inert');
  });

  it('calls a guard that passes then fails LIVE', () => {
    expect(classify({ beforeOk: true, afterOk: false })).toBe('live');
  });

  it('never reports live for a guard that passed both times', () => {
    // The inversion guard. A `live` here would mean the script blesses exactly
    // the guards it was written to catch.
    for (const beforeOk of [true, false]) {
      for (const afterOk of [true, false]) {
        const verdict = classify({ beforeOk, afterOk });
        if (verdict === 'live') expect({ beforeOk, afterOk }).toEqual({ beforeOk: true, afterOk: false });
      }
    }
  });
});

describe('selectTargets', () => {
  const guarded = { path: 'src/a.ts', status: 'carried', guard: 'cmd a' };
  const waived = { path: 'src/b.ts', status: 'carried', guard_waiver: 'no separate command' };
  const gone = { path: 'src/c.ts', status: 'superseded', guard: 'cmd c' };

  it('checks carried patches that name a guard', () => {
    expect(selectTargets(manifestOf(guarded)).map((t: Patch) => t.path)).toEqual(['src/a.ts']);
  });

  it('skips a carried patch with no guard — there is nothing to run', () => {
    expect(selectTargets(manifestOf(waived))).toEqual([]);
  });

  it('skips a superseded patch even though it names a guard', () => {
    // Its content is gone from the tree, so "revert it and re-run" is not a
    // question that has an answer.
    expect(selectTargets(manifestOf(gone))).toEqual([]);
  });

  it('narrows to one path with --only', () => {
    const second = { path: 'src/d.ts', status: 'carried', guard: 'cmd d' };
    const picked = selectTargets(manifestOf(guarded, second), 'src/d.ts');
    expect(picked.map((t: Patch) => t.path)).toEqual(['src/d.ts']);
  });

  it('returns nothing when --only names a path that is not a target', () => {
    // Fails empty rather than silently checking everything — a typo'd --only
    // that ran the full mutating sweep would be a nasty surprise.
    expect(selectTargets(manifestOf(guarded), 'src/typo.ts')).toEqual([]);
  });

  it('treats a null `only` as "everything"', () => {
    expect(selectTargets(manifestOf(guarded), null)).toHaveLength(1);
  });
});

describe('parseArgs', () => {
  it('defaults to a full run', () => {
    expect(parseArgs([])).toEqual({ listOnly: false, only: null });
  });

  it('reads --list', () => {
    expect(parseArgs(['--list'])).toEqual({ listOnly: true, only: null });
  });

  it('reads --only with its value', () => {
    expect(parseArgs(['--only', 'src/a.ts'])).toEqual({ listOnly: false, only: 'src/a.ts' });
  });

  it('combines --list and --only', () => {
    expect(parseArgs(['--list', '--only', 'src/a.ts'])).toEqual({ listOnly: true, only: 'src/a.ts' });
  });
});
