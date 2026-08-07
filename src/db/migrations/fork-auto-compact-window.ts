/**
 * Fork migration (vosburg-auto): per-group Claude Code auto-compact threshold.
 *
 * Named `fork-*` and numbered outside upstream's range for the same reason the
 * `module-*` migrations are: upstream keeps claiming sequential numbers, and
 * this migration originally shipped as `016-auto-compact-window`. The v2.1.54
 * sync brought upstream's own 016–021, forcing a rename — a step that is
 * silently destructive if done wrong, and that recurs at every sync while the
 * file sits in the numeric range upstream is walking through. Out of that range,
 * it never needs renaming again.
 *
 * `name` is the schema_version key (unique index `idx_schema_version_name`;
 * `version` is only an ordering hint and is re-assigned at insert time). It MUST
 * stay 'auto-compact-window' — the deployed install has already applied it under
 * that key, and a drifted name re-runs `up()` on a table that already has the
 * column. The `table_info` guard below makes that survivable rather than fatal:
 * without it the bare ALTER throws `duplicate column name`, `runMigrations`
 * throws out of `main()` at boot, and the host crash-loops.
 *
 * See docs/BRANCH-FORK-MAINTENANCE.md.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const forkAutoCompactWindow: Migration = {
  version: 900,
  name: 'auto-compact-window',
  up(db: Database.Database) {
    // Idempotency guard, same shape as 012/016 — see header for why this is
    // load-bearing rather than defensive decoration.
    const cols = db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'auto_compact_window')) return;

    // Per-group Claude Code auto-compact threshold (tokens). NULL = provider
    // default (the agent-runner's built-in 165000 or its env override).
    db.prepare('ALTER TABLE container_configs ADD COLUMN auto_compact_window INTEGER').run();
  },
};
