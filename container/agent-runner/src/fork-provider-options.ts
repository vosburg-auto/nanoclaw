/**
 * Fork patch (vosburg-auto): compile-time guard for the auto-compact window
 * pass-through.
 *
 * The per-group auto-compact setting spans eleven fork-modified paths, but its
 * whole runtime effect hangs on ONE line in `src/index.ts`:
 *
 *     autoCompactWindow: config.autoCompactWindow,
 *
 * Delete that line and nothing goes red. `ProviderOptions.autoCompactWindow` is
 * optional, so `tsc` stays clean; `claude-auto-compact.test.ts` unit-tests
 * `resolveAutoCompactWindow` in isolation, so it stays green; the host's
 * migration test never touches the container, so it stays green — and every
 * group silently falls back to the env value or the built-in 165000. That is a
 * dead detector, and dead detectors are how this fork lost two hardenings in the
 * v2.1.54 sync.
 *
 * `ForkProviderOptions` makes the property REQUIRED (still nullable — the value
 * may legitimately be undefined, meaning "provider default"). Routing the
 * options literal through `forkProviderOptions()` means removing the line is a
 * compile error at that call site, and the guard itself lives in a fork-owned
 * file that a wholesale take of an upstream file cannot delete.
 *
 * Deliberately NOT done by making the field required on `ProviderOptions`
 * itself: that breaks three unrelated `createProvider(name, {})` sites in
 * upstream-owned files, trading one guard for three new carry-forward hunks.
 *
 * See docs/fork-patches.json.
 */
import type { ProviderOptions } from './providers/types.js';

/** `ProviderOptions` with the fork's auto-compact pass-through made mandatory. */
export type ForkProviderOptions = ProviderOptions & { autoCompactWindow: number | undefined };

/** Identity at runtime; the type parameter is the entire point. */
export function forkProviderOptions(options: ForkProviderOptions): ProviderOptions {
  return options;
}
