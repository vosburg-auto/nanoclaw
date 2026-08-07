/**
 * Fork patch (vosburg-auto): guards the startup ordering in `src/index.ts`.
 *
 * `enforceUpgradeTripwire()` must run BEFORE `enforceStartupBackoff()`.
 * enforceStartupBackoff persists an incremented attempt count before it sleeps,
 * and resetCircuitBreaker() only runs from shutdown() — so with the tripwire
 * second, a deterministic refusal-to-start (which exits before any clean
 * shutdown) is recorded as a crash on every boot under Restart=always. The
 * operator then stamps the marker and the first CORRECT boot sleeps up to 900s
 * logging "delaying startup due to repeated crashes".
 *
 * SCOPE — read before trusting this. This is a SOURCE-ORDER assertion, not a
 * behavioural one. `main()` in src/index.ts is not exported and its first steps
 * do real filesystem and process work, so there is no seam to drive it through
 * in a unit test. What this proves: the two calls appear in the required order
 * in the file. What it does NOT prove: that either call does what its name says.
 * That is weaker than the other fork guards in docs/fork-patches.json, and it is
 * recorded here rather than papered over.
 *
 * It is still worth having: the failure it catches is a wholesale re-take of
 * upstream's `src/index.ts` at the next sync, which silently restores upstream's
 * ordering. That is exactly how this fork lost two hardenings in v2.1.54.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect } from 'vitest';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');

const source = fs.readFileSync(INDEX, 'utf8');

/**
 * Line number of the first real CALL to `fn`, ignoring imports and comments.
 * Both matter here: the import statement names both functions, and the comment
 * explaining the ordering names the other function — either would make a naive
 * indexOf match the wrong occurrence. (It did, on the first version of this test.)
 */
function callLine(fn: string): number {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const code = line.split('//')[0]!;
    if (code.trimStart().startsWith('*') || code.trimStart().startsWith('/*')) continue;
    if (code.includes('import ')) continue;
    if (new RegExp(`\\b${fn}\\s*\\(`).test(code)) return i + 1;
  }
  return -1;
}

describe('host startup ordering', () => {
  it('calls the upgrade tripwire before the restart-backoff counter', () => {
    const tripwire = callLine('enforceUpgradeTripwire');
    const backoff = callLine('enforceStartupBackoff');

    expect(tripwire, 'no enforceUpgradeTripwire() call found in src/index.ts').toBeGreaterThan(0);
    expect(backoff, 'no enforceStartupBackoff() call found in src/index.ts').toBeGreaterThan(0);
    expect(
      tripwire,
      `enforceUpgradeTripwire() (line ${tripwire}) must precede enforceStartupBackoff() ` +
        `(line ${backoff}) — otherwise a refusal to start is counted as a crash and throttles ` +
        'the first good boot. See the header of this file.',
    ).toBeLessThan(backoff);
  });

  it('matches calls, not imports or comments', () => {
    // Guards the guard: if callLine() ever starts matching the import line, the
    // ordering assertion above becomes meaningless (both would resolve to it).
    expect(callLine('enforceUpgradeTripwire')).not.toBe(callLine('enforceStartupBackoff'));
    const importLine = source.split('\n').findIndex((l) => l.includes('import') && l.includes('enforceStartupBackoff'));
    if (importLine !== -1) {
      expect(callLine('enforceStartupBackoff')).not.toBe(importLine + 1);
    }
  });
});
