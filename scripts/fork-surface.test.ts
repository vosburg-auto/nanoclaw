/**
 * Tests for the fork-surface reconciliation.
 *
 * This script is the fork's early-warning system: it is what would have caught
 * the two hardenings the v2.1.54 upstream sync silently reverted. It had no
 * tests, which is an uncomfortable place for a safety net to be — a review of
 * PR #9 called it out, and this is the answer.
 *
 * The cases that matter (an undispositioned path, a stale manifest claim, a
 * carried source patch with no guard) cannot be staged in the real repo without
 * breaking it, so they are exercised against the pure `reconcile` over synthetic
 * manifests. The git-touching derivation (`forkModifiedPaths`) is deliberately
 * NOT unit-tested here — stubbing git would only assert the stub.
 *
 * Filename note: `scripts/fork-surface.test.ts` does not exist upstream, so an
 * upstream sync cannot quietly delete it along with the feature. That is the
 * exact failure mode described in this script's own header.
 */
import { describe, expect, it } from 'vitest';

import { KINDS, loadManifest, parseArgs, reconcile, renderReport } from './fork-surface.mjs';

type Patch = {
  path: string;
  kind: string;
  status: string;
  intent: string;
  guard?: string;
  guard_waiver?: string;
};

const patch = (over: Partial<Patch> = {}): Patch => ({
  path: 'src/thing.ts',
  kind: 'source',
  status: 'carried',
  intent: 'A sufficiently long intent string.',
  guard: 'pnpm exec vitest run src/thing.test.ts',
  ...over,
});

const manifestOf = (...patches: Patch[]) => ({ patches });

describe('reconcile — agreement', () => {
  it('reports nothing when the manifest and the query agree', () => {
    const m = manifestOf(patch());
    expect(reconcile(['src/thing.ts'], m)).toEqual([]);
  });

  it('accepts an array or a Set for the derived paths', () => {
    const m = manifestOf(patch());
    expect(reconcile(new Set(['src/thing.ts']), m)).toEqual([]);
  });

  it('is silent about a superseded patch the tree no longer carries', () => {
    // This is the whole point of the `superseded` status: the patch is gone and
    // that IS the recorded disposition, so it must not read as staleness.
    const m = manifestOf(patch({ status: 'superseded' }));
    expect(reconcile([], m)).toEqual([]);
  });
});

describe('reconcile — direction 1: the query found something the manifest does not know', () => {
  it('flags a fork-modified path absent from the manifest', () => {
    const problems = reconcile(['src/thing.ts', 'src/sneaky.ts'], manifestOf(patch()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('UNDISPOSITIONED');
    expect(problems[0]).toContain('src/sneaky.ts');
  });

  it('names the ref it was checked against', () => {
    const [problem] = reconcile(['src/sneaky.ts'], manifestOf(), 'origin/main');
    expect(problem).toContain('origin/main');
  });
});

describe('reconcile — direction 2: the manifest claims a patch the tree no longer carries', () => {
  it('flags a carried patch whose content now matches upstream', () => {
    // The v2.1.54 regression in miniature: the patch is gone, the manifest
    // still claims it. Silence here is exactly what let those reverts land.
    const problems = reconcile([], manifestOf(patch()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('STALE');
    expect(problems[0]).toContain('src/thing.ts');
  });

  it('flags any non-superseded status, not just "carried"', () => {
    const [problem] = reconcile([], manifestOf(patch({ status: 'pending' })));
    expect(problem).toContain('STALE');
  });
});

describe('reconcile — manifest hygiene', () => {
  it('requires a carried SOURCE patch to name a guard or waive it', () => {
    const noGuard = patch({ guard: undefined });
    const [problem] = reconcile(['src/thing.ts'], manifestOf(noGuard));
    expect(problem).toContain('no `guard` and no `guard_waiver`');
  });

  it('accepts an explicit waiver in place of a guard', () => {
    const waived = patch({ guard: undefined, guard_waiver: 'covered by the e2e suite' });
    expect(reconcile(['src/thing.ts'], manifestOf(waived))).toEqual([]);
  });

  it('does not demand a guard for non-source kinds', () => {
    // A test or doc patch has no separate command that goes red without it.
    for (const kind of ['test', 'doc', 'config', 'generated']) {
      const p = patch({ path: `x/${kind}`, kind, guard: undefined });
      expect(reconcile([`x/${kind}`], manifestOf(p)), kind).toEqual([]);
    }
  });

  it('does not demand a guard for a superseded source patch', () => {
    const p = patch({ status: 'superseded', guard: undefined });
    expect(reconcile([], manifestOf(p))).toEqual([]);
  });

  it('rejects an unknown kind and lists the allowed ones', () => {
    const [problem] = reconcile(['src/thing.ts'], manifestOf(patch({ kind: 'sourcecode' })));
    expect(problem).toContain('kind must be one of');
    for (const k of KINDS) expect(problem).toContain(k);
  });

  it('rejects a missing or perfunctory intent', () => {
    expect(reconcile(['src/thing.ts'], manifestOf(patch({ intent: '' })))[0]).toContain('needs a real `intent`');
    expect(reconcile(['src/thing.ts'], manifestOf(patch({ intent: 'fix' })))[0]).toContain('needs a real `intent`');
    // Boundary: the rule is length < 10, so exactly 10 characters must pass.
    expect(reconcile(['src/thing.ts'], manifestOf(patch({ intent: 'x'.repeat(10) })))).toEqual([]);
    expect(reconcile(['src/thing.ts'], manifestOf(patch({ intent: 'x'.repeat(9) })))[0]).toContain('real `intent`');
  });

  it('flags a duplicate path', () => {
    const problems = reconcile(['src/thing.ts'], manifestOf(patch(), patch()));
    expect(problems.some((p) => p.includes('duplicate manifest entry'))).toBe(true);
  });

  it('flags an entry with no path', () => {
    const problems = reconcile([], manifestOf({ ...patch(), path: '' } as Patch));
    expect(problems.some((p) => p.includes('manifest entry with no `path`'))).toBe(true);
  });

  it('reports several independent problems at once rather than stopping at the first', () => {
    const problems = reconcile(
      ['src/undispositioned.ts'],
      manifestOf(patch({ kind: 'nope', intent: 'x' }), patch({ path: 'src/gone.ts' })),
    );
    expect(problems.length).toBeGreaterThan(3);
  });
});

describe('renderReport', () => {
  it('lists carried patches, sorted, with the guard column', () => {
    const out = renderReport(
      ['b.ts', 'a.ts'],
      manifestOf(patch({ path: 'b.ts' }), patch({ path: 'a.ts', guard: 'make check' })),
    );
    expect(out.indexOf('`a.ts`')).toBeLessThan(out.indexOf('`b.ts`'));
    expect(out).toContain('`make check`');
  });

  it('marks a patch the tree no longer carries as MISSING', () => {
    const out = renderReport([], manifestOf(patch()));
    expect(out).toContain('**(MISSING)**');
  });

  it('shows the waiver text when there is no guard', () => {
    const out = renderReport(['src/thing.ts'], manifestOf(patch({ guard: undefined, guard_waiver: 'e2e only' })));
    expect(out).toContain('_waived: e2e only_');
  });

  it('omits superseded patches', () => {
    const out = renderReport([], manifestOf(patch({ path: 'src/old.ts', status: 'superseded' })));
    expect(out).not.toContain('src/old.ts');
  });
});

describe('parseArgs', () => {
  it('defaults to list at HEAD', () => {
    expect(parseArgs([])).toEqual({ cmd: 'list', ref: 'HEAD' });
  });

  it('reads the command and --ref', () => {
    expect(parseArgs(['check', '--ref', 'origin/main'])).toEqual({ cmd: 'check', ref: 'origin/main' });
  });

  it('does not mistake a leading flag for a command', () => {
    expect(parseArgs(['--ref', 'x'])).toEqual({ cmd: 'list', ref: 'x' });
  });
});

describe('the real manifest', () => {
  // Not a substitute for `fork-surface.mjs check` in CI (which also runs the git
  // derivation); this catches a malformed entry without needing an upstream remote,
  // so it still fires on a fresh clone where the CI gate cannot run.
  it('is internally well-formed', () => {
    const m = loadManifest();
    expect(m.patches.length).toBeGreaterThan(0);
    const derived = m.patches.filter((p: Patch) => p.status !== 'superseded').map((p: Patch) => p.path);
    // Feed the manifest its own carried paths: any problem left is an entry
    // defect (bad kind, thin intent, duplicate, missing guard), not a drift
    // between manifest and tree.
    expect(reconcile(derived, m)).toEqual([]);
  });
});
