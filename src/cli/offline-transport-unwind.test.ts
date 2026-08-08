/**
 * OfflineTransport.open() must unwind the handle it opened.
 *
 * initDb() opens the database, then ensurePrivateDb() (which throws on a failed
 * chmod) and runMigrations() run before `opened` is set. Without an unwind, either
 * throw leaves an open handle behind — and close() is a no-op for the caller
 * because it never learns an open happened. It survived in practice only because
 * client.ts calls close() on its error path, which is a cross-file courtesy rather
 * than this class's own contract.
 *
 * Separate file because it needs the db/connection module MOCKED to observe
 * closeDb(); the main offline-transport test exercises the real database. The
 * observable assertion is the point: an earlier version of this test asserted only
 * that the error propagated, which is true with or without the unwind — it passed
 * against the unfixed code, and mutation-checking caught it rather than review.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const initDb = vi.hoisted(() => vi.fn(() => ({})));
const closeDb = vi.hoisted(() => vi.fn());
const runMigrations = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('../db/connection.js', () => ({ initDb, closeDb, getDb: vi.fn() }));
vi.mock('../db/migrations/index.js', () => ({ runMigrations }));
vi.mock('./dispatch.js', () => ({ dispatch }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const load = async () => (await import('./offline-transport.js')).OfflineTransport;
const frame = { id: 'x', command: 'help', args: {} };

describe('open() unwinds on failure', () => {
  it('closes the handle when ensurePrivateDb throws', async () => {
    const fs = (await import('fs')).default;
    // A fresh DB: absent when assertPrivateDb runs (so it returns early), then
    // created loose by initDb. That is the only path on which ensurePrivateDb
    // reaches its chmod — a pre-existing loose file trips assertPrivateDb first.
    // statSync is called TWICE with different meanings: assertPrivateDb asks
    // first (file absent -> it returns early, which is the fresh-install case),
    // then ensurePrivateDb asks after initDb created it loose.
    let stats = 0;
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      if (stats++ === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mode: 0o100644 } as unknown as ReturnType<typeof fs.statSync>;
    });
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // no socket => host not running

    const OfflineTransport = await load();
    const t = new OfflineTransport({ dbPath: '/tmp/does-not-matter/v2.db' });
    await expect(t.sendFrame(frame)).rejects.toThrow(/could not make .* private/);

    expect(initDb, 'precondition: the handle was actually opened').toHaveBeenCalled();
    expect(closeDb, 'THE ASSERTION: the opened handle must be closed on the throw').toHaveBeenCalled();
  });

  it('closes the handle when runMigrations throws', async () => {
    const fs = (await import('fs')).default;
    vi.spyOn(fs, 'statSync').mockReturnValue({ mode: 0o100600 } as unknown as ReturnType<typeof fs.statSync>);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    runMigrations.mockImplementation(() => {
      throw new Error('migration blew up');
    });

    const OfflineTransport = await load();
    const t = new OfflineTransport({ dbPath: '/tmp/does-not-matter/v2.db', migrate: true });
    await expect(t.sendFrame(frame)).rejects.toThrow(/migration blew up/);
    expect(closeDb, 'a migration failure must not leak the handle either').toHaveBeenCalled();
  });

  it('does NOT close on a successful open', async () => {
    const fs = (await import('fs')).default;
    vi.spyOn(fs, 'statSync').mockReturnValue({ mode: 0o100600 } as unknown as ReturnType<typeof fs.statSync>);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const OfflineTransport = await load();
    const t = new OfflineTransport({ dbPath: '/tmp/does-not-matter/v2.db' });
    await t.sendFrame(frame);
    expect(closeDb, 'the happy path must keep the handle for the caller').not.toHaveBeenCalled();
    t.close();
    expect(closeDb).toHaveBeenCalled();
  });
});
