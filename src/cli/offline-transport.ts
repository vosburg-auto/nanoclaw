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
 * NOT A PRIVILEGE ESCALATION — and this is worth stating because it looks like
 * one. The context is `caller: 'host'`, which `guard/index.ts` treats as trusted
 * and exempt from `access: 'approval'`. That is the SAME authority an operator
 * already has by running `ncl` against the 0600 socket; the approval gate exists
 * to hold AGENT-initiated calls, never operator ones. Offline mode reaches it
 * through file-system access to `data/v2.db` instead of file-system access to
 * `data/ncl.sock` — the same 0600-owner-only precondition, so the trust boundary
 * is unchanged. It is deliberately NOT exposed to containers: nothing in
 * `container/` can construct this transport, because the agent-runner never has
 * the host's data directory mounted.
 *
 * See docs/fork-patches.json.
 */
import path from 'path';

import { DATA_DIR } from '../config.js';
import { initDb, closeDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import type { Transport } from './transport.js';

/** Set to any non-empty value to route `ncl` through the DB instead of the socket. */
export const OFFLINE_ENV = 'NANOCLAW_OFFLINE';

export function offlineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OFFLINE_ENV];
  return typeof v === 'string' && v !== '' && v !== '0';
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
    const db = initDb(dbPath);
    if (this.opts.migrate) runMigrations(db);
    this.opened = true;
  }

  async sendFrame(req: RequestFrame): Promise<ResponseFrame> {
    this.open();
    return dispatch(req, { caller: 'host' });
  }

  close(): void {
    if (!this.opened) return;
    closeDb();
    this.opened = false;
  }
}
