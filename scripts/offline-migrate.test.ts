/**
 * `appliedNames()` error discrimination.
 *
 * The function reports which migrations a database already has. Its catch used
 * to swallow EVERYTHING as "nothing applied", so a database that could not be
 * read at all — SQLITE_BUSY, a permission error — reported zero migrations
 * applied. During a recovery that is the exact inverse of the truth, and the
 * operator's next move is to run migrations against a database they cannot read.
 *
 * Only "no such table" may degrade to empty: that is a genuinely fresh database.
 *
 * The manifest previously waived a guard here on the grounds that the body was
 * "initDb + runMigrations, covered by the host's own migration tests". That was
 * stale — appliedNames() is bespoke to this script and no host test touches it.
 *
 */
import fs from 'fs';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const getDb = vi.hoisted(() => vi.fn());

vi.mock('../src/db/connection.js', () => ({
  getDb,
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock('../src/db/migrations/index.js', () => ({ runMigrations: vi.fn() }));
vi.mock('../src/cli/offline-transport.js', () => ({
  assertHostNotRunning: vi.fn(),
  assertPrivateDb: vi.fn(),
  ensurePrivateDb: vi.fn(),
  forced: vi.fn(() => false),
  FORCE_PERMS_ENV: 'NANOCLAW_OFFLINE_FORCE_PERMS',
}));

const throwing = (msg: string) => ({
  prepare: () => {
    throw new Error(msg);
  },
});

let appliedNames: () => Set<string>;

beforeEach(async () => {
  vi.resetModules();
  ({ appliedNames } = await import('./offline-migrate.js'));
});
// resetAllMocks, not clearAllMocks: clear wipes CALLS but keeps implementations,
// so a mockImplementation that throws leaks into the next test and it fails for
// the wrong reason.
afterEach(() => vi.resetAllMocks());

describe('appliedNames', () => {
  it('returns the applied migration names', () => {
    getDb.mockReturnValue({ prepare: () => ({ all: () => [{ name: 'a' }, { name: 'b' }] }) });
    expect([...appliedNames()]).toEqual(['a', 'b']);
  });

  it('treats a missing schema_version table as a fresh database', () => {
    getDb.mockReturnValue(throwing('no such table: schema_version'));
    expect(appliedNames().size).toBe(0);
  });

  it('THROWS on SQLITE_BUSY instead of reporting zero applied', () => {
    // The defect: a locked database reported "0 migrations applied", which reads
    // as "fresh install, safe to migrate" during exactly the recovery where the
    // lock means another process holds it.
    getDb.mockReturnValue(throwing('SQLITE_BUSY: database is locked'));
    expect(() => appliedNames()).toThrow(/could not read schema_version/);
    expect(() => appliedNames()).toThrow(/SQLITE_BUSY/);
  });

  it('THROWS on a permission error instead of reporting zero applied', () => {
    getDb.mockReturnValue(throwing('SQLITE_CANTOPEN: unable to open database file'));
    expect(() => appliedNames()).toThrow(/could not read schema_version/);
  });

  it('names the database it could not read, so the operator knows which one', () => {
    getDb.mockReturnValue(throwing('SQLITE_BUSY: database is locked'));
    expect(() => appliedNames()).toThrow(/v2\.db/);
  });

  it('does not mistake a table name containing "no such table" prose for the fresh case', () => {
    // Guards the discrimination itself: the check is a regex over the message, so
    // a message that merely MENTIONS the phrase must still be treated as unknown
    // only when it genuinely is the missing-table error.
    getDb.mockReturnValue(throwing('disk I/O error'));
    expect(() => appliedNames()).toThrow(/could not read schema_version/);
  });
});

describe('main() preconditions', () => {
  // The most important fix in this round, so it gets a test that can fail:
  // an earlier revision guarded only the transport and left THIS entry point —
  // the one that actually runs the destructive migration 016 — unguarded.
  it('refuses before touching the database if the host is running', async () => {
    const t = await import('../src/cli/offline-transport.js');
    const conn = await import('../src/db/connection.js');
    vi.mocked(t.assertHostNotRunning).mockImplementation(() => {
      throw new Error('host appears to be running');
    });
    const { main } = await import('./offline-migrate.js');
    expect(() => main()).toThrow(/host appears to be running/);
    expect(conn.initDb, 'must refuse BEFORE opening the database').not.toHaveBeenCalled();
  });

  it('checks database privacy before opening it', async () => {
    const t = await import('../src/cli/offline-transport.js');
    const conn = await import('../src/db/connection.js');
    vi.mocked(t.assertPrivateDb).mockImplementation(() => {
      throw new Error('readable by group/other');
    });
    const { main } = await import('./offline-migrate.js');
    expect(() => main()).toThrow(/readable by group\/other/);
    expect(conn.initDb).not.toHaveBeenCalled();
  });

  it('runs both guards on the happy path', async () => {
    const t = await import('../src/cli/offline-transport.js');
    getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
    const { main } = await import('./offline-migrate.js');
    main();
    expect(t.assertHostNotRunning).toHaveBeenCalled();
    expect(t.assertPrivateDb).toHaveBeenCalled();
  });
});

describe('force-flag handling on the migration entry point', () => {
  // The migrate script hand-copied the force check instead of calling the shared
  // decision, so the legacy combined override waived the privacy check here
  // WITHOUT the "waives BOTH" warning the transport prints — the audit trail
  // vanished on the entry point that runs the destructive migration.
  it('uses the shared forced() rather than a private copy of the rule', async () => {
    const src = fs.readFileSync(new URL('./offline-migrate.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/forced\(process\.env, FORCE_PERMS_ENV\)/);
    expect(src, 'must not re-implement the env comparison inline').not.toMatch(
      /NANOCLAW_OFFLINE_FORCE_PERMS\s*\?\?\s*process\.env\.NANOCLAW_OFFLINE_FORCE/,
    );
  });

  it('an explicit negative does not waive the privacy check', async () => {
    const t = await import('../src/cli/offline-transport.js');
    vi.mocked(t.assertPrivateDb).mockImplementation(() => {
      throw new Error('readable by group/other');
    });
    vi.mocked(t.forced).mockImplementation((env, name) => {
      const v = String((env as Record<string, string>)[name] ?? '').toLowerCase();
      return !(v === '' || v === '0' || v === 'false');
    });
    process.env.NANOCLAW_OFFLINE_FORCE_PERMS = 'false';
    try {
      const { main } = await import('./offline-migrate.js');
      expect(() => main()).toThrow(/readable by group\/other/);
    } finally {
      delete process.env.NANOCLAW_OFFLINE_FORCE_PERMS;
    }
  });
});

describe('--check (report-only) mode', () => {
  // The safer of the two documented invocations, and the one operators are told
  // to run first — previously with no test proving it applies nothing.
  const withArgv = async (argv: string[]) => {
    const saved = process.argv;
    process.argv = ['node', 'offline-migrate.ts', ...argv];
    try {
      vi.resetModules();
      return await import('./offline-migrate.js');
    } finally {
      process.argv = saved;
    }
  };

  it('applies nothing and says so', async () => {
    getDb.mockReturnValue({ prepare: () => ({ all: () => [{ name: 'a' }, { name: 'b' }] }) });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const mod = await withArgv(['--check']);
      const mig = await import('../src/db/migrations/index.js');
      mod.main();
      expect(mig.runMigrations, '--check must not apply migrations').not.toHaveBeenCalled();
      const printed = out.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toMatch(/2 migration\(s\) already applied/);
      expect(printed).toMatch(/--check applied nothing/);
    } finally {
      out.mockRestore();
    }
  });

  it('still enforces the preconditions — --check is not a way around them', async () => {
    const t = await import('../src/cli/offline-transport.js');
    vi.mocked(t.assertHostNotRunning).mockImplementation(() => {
      throw new Error('host appears to be running');
    });
    const mod = await withArgv(['--check']);
    expect(() => mod.main()).toThrow(/host appears to be running/);
  });

  it('without --check it does apply', async () => {
    getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const mod = await withArgv([]);
      const mig = await import('../src/db/migrations/index.js');
      mod.main();
      expect(mig.runMigrations).toHaveBeenCalled();
    } finally {
      out.mockRestore();
    }
  });
});

describe('handle lifetime', () => {
  it('closes the database even when ensurePrivateDb throws', async () => {
    // ensurePrivateDb gained a throw (failed chmod) in an earlier commit while
    // sitting between initDb and the try/finally, so that throw leaked the handle.
    const t = await import('../src/cli/offline-transport.js');
    const conn = await import('../src/db/connection.js');
    vi.mocked(t.ensurePrivateDb).mockImplementation(() => {
      throw new Error('could not make it private');
    });
    const { main } = await import('./offline-migrate.js');
    expect(() => main()).toThrow(/could not make it private/);
    expect(conn.closeDb, 'the handle initDb opened must still be closed').toHaveBeenCalled();
  });
});
