/**
 * Fork patch guard (vosburg-auto) for offline `ncl`.
 *
 * Fork-owned FILENAME on purpose: `src/cli/client.test.ts` is a name upstream
 * also owns, and the v2.1.54 sync proved that a wholesale take of such a file
 * deletes the feature and its detector in one commit with CI green.
 *
 * What has to go red if the patch is reverted:
 *   1. `pickTransport()` stops honoring NANOCLAW_OFFLINE  → the deadlock returns
 *   2. the transport stops dispatching as a HOST caller   → operator commands
 *      that carry `access: 'approval'` would hang forever with nobody to ask
 *   3. the transport starts migrating by default          → it would move the
 *      schema out from under a snapshot the operator has not taken yet
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFLINE_ENV, offlineRequested } from './offline-transport.js';

// vi.mock factories are hoisted above every top-level const, so the shared
// recorders come from vi.hoisted and DATA_DIR is a literal.
const TEST_DIR = '/tmp/nanoclaw-offline-transport-test';

const rec = vi.hoisted(() => ({
  dispatchCalls: [] as Array<{ command: string; caller: string }>,
  migrateCalls: [] as string[],
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-offline-transport-test' };
});

vi.mock('./dispatch.js', () => ({
  dispatch: vi.fn(async (req: { id: string; command: string }, ctx: { caller: string }) => {
    rec.dispatchCalls.push({ command: req.command, caller: ctx.caller });
    return { id: req.id, ok: true, data: {} };
  }),
}));

vi.mock('../db/migrations/index.js', () => ({
  runMigrations: vi.fn(() => {
    rec.migrateCalls.push('ran');
  }),
}));

const { dispatchCalls, migrateCalls } = rec;

beforeEach(() => {
  dispatchCalls.length = 0;
  migrateCalls.length = 0;
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('offlineRequested', () => {
  it('is off by default and opt-in by env', () => {
    expect(offlineRequested({})).toBe(false);
    expect(offlineRequested({ [OFFLINE_ENV]: '1' })).toBe(true);
    expect(offlineRequested({ [OFFLINE_ENV]: 'yes' })).toBe(true);
  });

  it('treats empty and "0" as OFF, not as "the variable is present"', () => {
    // `NANOCLAW_OFFLINE=` in a sourced .env is the shape that would otherwise
    // silently route every operator command away from the running host.
    expect(offlineRequested({ [OFFLINE_ENV]: '' })).toBe(false);
    expect(offlineRequested({ [OFFLINE_ENV]: '0' })).toBe(false);
  });
});

describe('OfflineTransport', () => {
  it('dispatches in-process as a HOST caller', async () => {
    const { OfflineTransport } = await import('./offline-transport.js');
    const t = new OfflineTransport({ dbPath: path.join(TEST_DIR, 'v2.db') });
    const res = await t.sendFrame({ id: 'r1', command: 'groups-list', args: {} });
    t.close();

    expect(res.ok).toBe(true);
    expect(dispatchCalls).toEqual([{ command: 'groups-list', caller: 'host' }]);
  });

  it('does NOT migrate unless asked — the operator snapshots before any schema change', async () => {
    const { OfflineTransport } = await import('./offline-transport.js');
    const t = new OfflineTransport({ dbPath: path.join(TEST_DIR, 'v2.db') });
    await t.sendFrame({ id: 'r1', command: 'groups-list', args: {} });
    t.close();
    expect(migrateCalls).toEqual([]);

    const m = new OfflineTransport({ dbPath: path.join(TEST_DIR, 'v2b.db'), migrate: true });
    await m.sendFrame({ id: 'r2', command: 'groups-list', args: {} });
    m.close();
    expect(migrateCalls).toEqual(['ran']);
  });

  it('opens the DB once across multiple frames', async () => {
    const { OfflineTransport } = await import('./offline-transport.js');
    const t = new OfflineTransport({ dbPath: path.join(TEST_DIR, 'v2.db'), migrate: true });
    await t.sendFrame({ id: 'r1', command: 'groups-list', args: {} });
    await t.sendFrame({ id: 'r2', command: 'groups-list', args: {} });
    t.close();
    expect(migrateCalls).toEqual(['ran']);
    expect(dispatchCalls).toHaveLength(2);
  });
});

describe('the client seam', () => {
  it('client.ts routes through the offline transport when the env var is set', () => {
    // Source-level assertion, because src/cli/client.ts self-executes main() on
    // import and cannot be imported into a test. This is what goes red when a
    // wholesale upstream take of client.ts drops the seam: the runtime effect
    // hangs entirely on that one branch, and nothing else in this file can see
    // it.
    const src = fs.readFileSync(path.join(__dirname, 'client.ts'), 'utf8');
    const pick = src.slice(src.indexOf('function pickTransport'));
    const body = pick.slice(0, pick.indexOf('\n}'));
    expect(body).toMatch(/offlineRequested\(\)/);
    expect(body).toMatch(/OfflineTransport/);
    // The offline branch must precede the socket default, or it can never be
    // reached. (toBeLessThan takes no message argument in this vitest version.)
    expect(body.indexOf('OfflineTransport') < body.indexOf('SocketTransport')).toBe(true);
  });
});
