/**
 * Fork patch (vosburg-auto): run `ncl` against the database with no host
 * process, to break the upgrade deadlock.
 *
 * THE DEADLOCK
 * ------------
 * The sanctioned upgrade order is: snapshot the DB, migrate memory, rebuild the
 * image, and stamp the upgrade marker LAST — stamping first writes the new
 * version before the work has happened and disarms `enforceUpgradeTripwire()`
 * exactly when it is most needed (`docs/upgrade-recovery.md` says the same).
 *
 * But `/migrate-memory` needs `ncl groups list` and `ncl tasks pause`, and `ncl`
 * speaks over `data/ncl.sock`, which only exists once the host has booted — and
 * the host refuses to boot until the marker is stamped. So the correct order is
 * unreachable: every path either boots with a premature marker or cannot run the
 * migration at all.
 *
 * WHY A TRANSPORT AND NOT A BOOT FLAG
 * -----------------------------------
 * The obvious alternative is an `--upgrade-in-progress` boot mode that serves
 * ncl while taking no traffic. It is a smaller diff and a worse design: it is a
 * flag whose whole purpose is to weaken a startup guard, so leaving it set is
 * both easy and silent, and the failure mode is a host that looks healthy while
 * the tripwire is disarmed indefinitely.
 *
 * This has no such state. `pickTransport()` was already a seam, and `dispatch()`
 * was already transport-agnostic — the socket server and the container poller
 * both call it with a `CallerContext`. So offline mode is a third caller of an
 * existing seam, not a new mode of the host: nothing is started, nothing
 * listens, and the process exits when the command does. There is no flag to
 * leave on.
 *
 * ON PRIVILEGE — the socket and the database are NOT equivalent gates, though
 * it is tempting to assume they are. On the live install the socket
 * is `srw------- (0600)` but the database is `-rw-r--r-- (0644)`, so the two
 * gates are NOT equivalent: the socket restricts all access to the owner, while
 * a world-readable DB lets any local user READ host state offline that the
 * socket would have refused them. Writes still require owner (0644 denies group
 * and other), so this widens the read surface, not the write surface.
 *
 * The `caller: 'host'` context itself is still right — `guard/index.ts` treats it
 * as trusted and exempt from `access: 'approval'`, which is the same authority an
 * operator already has at the socket; the approval gate exists to hold
 * AGENT-initiated calls, never operator ones. It is the file-permission
 * precondition that differs, so the transport CHECKS it (see assertPrivateDb)
 * and refuses a group/world-readable database rather than assuming a property
 * it has not verified. It is deliberately NOT exposed to containers: nothing in
 * `container/` can construct this transport, because the agent-runner never has
 * the host's data directory mounted.
 *
 * See docs/fork-patches.json.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { initDb, closeDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import type { Transport } from './transport.js';

/** Set to any non-empty value to route `ncl` through the DB instead of the socket. */
export const OFFLINE_ENV = 'NANOCLAW_OFFLINE';

/**
 * The ONE truthiness rule for every switch in this file.
 *
 * Explicit negatives mean OFF. `NANOCLAW_OFFLINE=false` used to ENABLE offline
 * mode because any non-empty string was truthy; that was fixed here — and then
 * `forced()` was written a few lines below with the identical bug, so
 * `NANOCLAW_OFFLINE_FORCE_LIVENESS=0` silently waived the check it names. There is now one parser, so
 * there is nowhere for a third instance to hide.
 */
export function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

export function offlineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, OFFLINE_ENV);
}

/**
 * Refuse to run offline while the host is up.
 *
 * The offline path opens `data/v2.db` directly. SQLite's own locking keeps the
 * FILE consistent, but the host caches state in memory (registries, sessions,
 * container config), so an offline mutation while it runs is invisible to it and
 * can be overwritten by the next thing the host flushes — and an offline
 * MIGRATION under a live host changes the schema beneath a process already
 * holding prepared statements. The socket's presence is the cheapest reliable
 * "host is up" signal, and it is the one the host itself creates.
 *
 * Overridable, because a stale socket after an unclean kill would otherwise trap
 * the operator in the very deadlock this feature exists to break.
 */
export const FORCE_LIVENESS_ENV = 'NANOCLAW_OFFLINE_FORCE_LIVENESS';
export const FORCE_PERMS_ENV = 'NANOCLAW_OFFLINE_FORCE_PERMS';
/** Legacy single switch — still honoured, but it waives BOTH checks, so it warns. */
export const FORCE_ENV = 'NANOCLAW_OFFLINE_FORCE';

export function forced(env: NodeJS.ProcessEnv, specific: string): boolean {
  if (envFlag(env, specific)) return true;
  if (!envFlag(env, FORCE_ENV)) return false;
  // One variable waiving two unrelated risks is how an operator clearing a stale
  // socket silently also accepts a world-readable database. Keep it working, but
  // say what it just did.
  process.stderr.write(
    `ncl: ${FORCE_ENV} waives BOTH the host-liveness and DB-privacy checks. ` +
      `Prefer ${FORCE_LIVENESS_ENV} or ${FORCE_PERMS_ENV} to waive only the one you mean.\n`,
  );
  return true;
}

export function assertHostNotRunning(env: NodeJS.ProcessEnv = process.env, dir: string = DATA_DIR): void {
  if (forced(env, FORCE_LIVENESS_ENV)) return;
  const sock = path.join(dir, 'ncl.sock');
  if (!fs.existsSync(sock)) return;
  throw new Error(
    `refusing to run offline: ${sock} exists, so the host appears to be running.\n` +
      `Offline mode writes the database directly and the running host caches state in memory,\n` +
      `so changes made now can be silently overwritten — and an offline migration would move the\n` +
      `schema under a live process. Stop the host first.\n` +
      `If the socket is stale after an unclean shutdown, set NANOCLAW_OFFLINE_FORCE=1.`,
  );
}

/**
 * Make a just-created database private.
 *
 * assertPrivateDb deliberately skips a DB that does not exist yet — but initDb
 * never chmods, so the file lands at whatever the umask allows (0644 under the
 * common 022). That is precisely the mode the guard exists to reject, so the
 * next offline command would refuse against a file WE created. The repo already
 * does this for its sockets (socket-server.ts, channels/cli.ts); this path just
 * wasn't following the house pattern.
 */
export function ensurePrivateDb(dbPath: string): void {
  let mode: number;
  try {
    mode = fs.statSync(dbPath).mode;
  } catch {
    return; // absent or unstattable — nothing to tighten; open() surfaces the real error
  }
  if ((mode & 0o077) === 0) return;
  // A FAILED chmod is a different thing entirely from an absent file, and the
  // single catch that covered both left a fresh database group/world-readable
  // with no warning at all. Refuse loudly instead: the whole point of this call
  // is that the file we just created must not be readable by anyone else.
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch (e: unknown) {
    throw new Error(
      `refusing to continue: could not make ${dbPath} private (mode ${(mode & 0o777).toString(8)}): ` +
        `${String((e as Error)?.message ?? e)}\nRun: chmod 600 ${dbPath}`,
    );
  }
}

/**
 * Refuse a group/world-readable database.
 *
 * Offline mode reaches `caller: 'host'` — the trusted context — through file
 * access to the DB rather than to the 0600 socket. Those are only equivalent
 * gates if the DB is equally private, and on the live install it is NOT (0644).
 * Rather than restate the assumption, check it.
 */
export function assertPrivateDb(dbPath: string): void {
  // ONE stat, reused. Statting again just to format the message means a file
  // that moves between the two calls throws a bare ENOENT instead of the
  // instruction this function exists to give. ensurePrivateDb below caches its
  // stat for the same reason.
  let mode: number;
  try {
    mode = fs.statSync(dbPath).mode;
  } catch {
    return; // absent DB is a fresh install; initDb creates it, ensurePrivateDb tightens it
  }
  if ((mode & 0o077) === 0) return;
  throw new Error(
    `refusing to run offline: ${dbPath} is readable by group/other (mode ${(mode & 0o777).toString(8)}).\n` +
      `Offline mode grants the trusted 'host' context to whoever can read this file, whereas the\n` +
      `socket restricts that to the owner. Run: chmod 600 ${dbPath}\n` +
      `(or set ${FORCE_PERMS_ENV}=1 if you have accepted the exposure on this host).`,
  );
}

/**
 * Dispatches in-process against `data/v2.db`.
 *
 * `migrate` is opt-in and defaults to FALSE. That default is load-bearing: the
 * operator runbook takes a DB snapshot before any schema change, and a transport
 * that silently migrated on first use would move the schema out from under a
 * snapshot the operator had not taken yet. Migrations run only when the operator
 * asks for them, which is what `scripts/offline.ts migrate` is for.
 */
export class OfflineTransport implements Transport {
  private opened = false;

  constructor(private readonly opts: { migrate?: boolean; dbPath?: string } = {}) {}

  private open(): void {
    if (this.opened) return;
    const dbPath = this.opts.dbPath ?? path.join(DATA_DIR, 'v2.db');
    assertHostNotRunning();
    if (!forced(process.env, FORCE_PERMS_ENV)) assertPrivateDb(dbPath);
    const db = initDb(dbPath);
    // Everything after the handle exists must unwind it. ensurePrivateDb throws
    // on a failed chmod and runMigrations can throw for any number of reasons;
    // without this, either one leaves an open handle behind with `opened` still
    // false. Today client.ts happens to call close() unconditionally on the error
    // path, but that is a cross-file courtesy, not this class's own contract.
    try {
      ensurePrivateDb(dbPath); // a DB we just created must not inherit a loose umask
      if (this.opts.migrate) runMigrations(db);
    } catch (e) {
      this.close();
      throw e;
    }
    this.opened = true;
  }

  async sendFrame(req: RequestFrame): Promise<ResponseFrame> {
    this.open();
    return dispatch(req, { caller: 'host' });
  }

  close(): void {
    // NOT gated on `opened`: that flag is set only after initDb() returns, so a
    // throw between the handle opening and the flag being set would leak it —
    // exactly the window a failing offline command runs through. closeDb() on a
    // never-opened DB is a no-op, so the unconditional call is the safe one.
    try {
      closeDb();
    } catch {
      /* nothing useful to do while tearing down */
    }
    this.opened = false;
  }
}
