/**
 * Fork patch guard (vosburg-auto): offline `ncl` must be able to RESOLVE a
 * command, not merely open the database.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM offline-transport.test.ts
 * -------------------------------------------------------------
 * That file mocks `./dispatch.js`, which is the right call for what it checks
 * (caller context, migrate default, unwind) — but it means the registry is never
 * consulted there, so it could not see that the registry was EMPTY. Offline
 * `ncl` shipped inert: `NANOCLAW_OFFLINE=1 ncl groups list` returned
 * `unknown-command` for every command on the deployed host. Five review passes
 * ran on the PR that introduced it, but they never converged — it was merged
 * over Request-changes / Broken verdicts as a stated exception, so "the panel
 * missed it" is only half true.
 *
 * The half that IS a blind spot: a mock standing in for the exact component
 * whose absence is the bug cannot detect the bug.
 *
 * So this file uses the REAL dispatch against a REAL temporary database. Delete
 * the `loadCommands()` call from `sendFrame` and both cases below go red — the
 * first with the literal `unknown-command` code, which is the production symptom
 * verbatim; the second with the registry count collapsing to zero.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb } from '../db/connection.js';
import { listCommands } from './registry.js';
import { FORCE_LIVENESS_ENV, OfflineTransport } from './offline-transport.js';

let dir: string | undefined;
let dbPath: string;
let priorForceLiveness: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-offline-registry-'));
  dbPath = path.join(dir, 'v2.db');
  // The liveness check looks for data/ncl.sock under the REPO's DATA_DIR, which
  // on a dev box may genuinely have a host running. The property under test is
  // command resolution, not the liveness gate (covered next door), so waive it.
  // Saved and RESTORED rather than deleted: process.env is shared, and a test
  // that clears a variable it did not set silently changes the environment for
  // whatever runs next.
  priorForceLiveness = process.env[FORCE_LIVENESS_ENV];
  process.env[FORCE_LIVENESS_ENV] = '1';
});

afterEach(() => {
  closeDb();
  if (priorForceLiveness === undefined) delete process.env[FORCE_LIVENESS_ENV];
  else process.env[FORCE_LIVENESS_ENV] = priorForceLiveness;
  // Guarded: if mkdtempSync above threw, `dir` is undefined and an unguarded
  // rmSync raises a TypeError that MASKS the real setup failure.
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('offline transport populates the command registry', () => {
  it('resolves a real command instead of returning unknown-command', async () => {
    const t = new OfflineTransport({ migrate: true, dbPath });
    try {
      const res = await t.sendFrame({ id: 'test-1', command: 'groups-list', args: {} });
      // Both assertions are wanted, and the ORDER is the point: the code check
      // runs first so a registry regression fails with the production symptom
      // named, rather than with a bare "expected false to be true" that says
      // nothing about which defect just reappeared. `ok` is then asserted too —
      // an unrelated handler failure SHOULD fail this test, it just should not
      // be the line the reader sees first.
      if (!res.ok) expect(res.error.code, res.error.message).not.toBe('unknown-command');
      expect(res.ok).toBe(true);
    } finally {
      t.close();
    }
  });

  it('leaves the registry non-empty after a frame', async () => {
    // The measured regression was 0 commands before the barrel is imported and
    // 71 after. There is deliberately NO assertion of the empty "before" state:
    // vitest shares one module registry across a file, so the first test above
    // already loaded the barrel and such an assertion passes or fails on test
    // ORDER rather than on the code. Bound loosely below — the exact count is
    // upstream's to move.
    const t = new OfflineTransport({ migrate: true, dbPath });
    try {
      await t.sendFrame({ id: 'test-2', command: 'groups-list', args: {} });
      expect(listCommands().length).toBeGreaterThan(20);
    } finally {
      t.close();
    }
  });
});
