/**
 * Fork patch (vosburg-auto): guards the auto-compact pass-through in index.ts.
 *
 * `fork-provider-options.ts` makes the property required, so DELETING the
 * pass-through line is a compile error. It cannot catch the other revert mode:
 * taking upstream's `src/index.ts` wholesale removes the `forkProviderOptions()`
 * wrapper AND its import along with the line, and `tsc` is clean again — the
 * feature dies silently. `scripts/fork-guard-liveness.mjs` found exactly that.
 *
 * So this file covers the whole-file revert. It is a SOURCE-LEVEL assertion:
 * `main()` is not exported and its first steps do real filesystem and process
 * work, so there is no seam to drive it through. What it proves is that the
 * wiring is present in the file; not that it behaves. Stated plainly rather
 * than implied away — see docs/fork-patches.json.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { forkProviderOptions } from './fork-provider-options.js';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');
const source = readFileSync(INDEX, 'utf8');

describe('auto-compact pass-through wiring', () => {
  it('routes the provider options literal through forkProviderOptions', () => {
    expect(source).toContain('forkProviderOptions(');
    expect(source).toContain("from './fork-provider-options.js'");
  });

  it('passes the per-group window from the loaded config', () => {
    // The one line the whole feature hangs on. Without it every group silently
    // falls back to the env value or the built-in default.
    expect(source).toContain('autoCompactWindow: config.autoCompactWindow');
  });

  it('wraps the call that actually constructs the provider', () => {
    // Guards the guard: forkProviderOptions must wrap the createProvider
    // argument, not sit somewhere inert in the file.
    const call = source.indexOf('createProvider(');
    expect(call).toBeGreaterThan(-1);
    const window = source.slice(call, call + 600);
    expect(window).toContain('forkProviderOptions(');
  });

  it('is a typed identity at runtime', () => {
    const opts = { model: 'sonnet', autoCompactWindow: 450000 };
    expect(forkProviderOptions(opts)).toBe(opts);
    expect(forkProviderOptions({ autoCompactWindow: undefined })).toEqual({ autoCompactWindow: undefined });
  });
});
