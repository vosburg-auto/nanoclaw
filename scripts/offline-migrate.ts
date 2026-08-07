#!/usr/bin/env tsx
/**
 * Fork patch (vosburg-auto): run the central-DB schema migrations with no host
 * process, as the upgrade runbook's explicit step.
 *
 * Migrations normally run inside `main()` in src/index.ts, which the upgrade
 * tripwire refuses to reach until the marker is stamped — and the marker must be
 * stamped LAST. This is the other half of the deadlock that
 * src/cli/offline-transport.ts documents; that file handles `ncl` commands, this
 * one handles the schema.
 *
 *   pnpm exec tsx scripts/offline-migrate.ts          # apply
 *   pnpm exec tsx scripts/offline-migrate.ts --check  # report only, apply nothing
 *
 * TAKE THE DB SNAPSHOT FIRST. Migration 016 drops and recreates
 * `messaging_groups` with no down migration; there is no undo here.
 *
 * This deliberately does NOT stamp the upgrade marker. Stamping is a separate,
 * deliberate, last step — a script that migrated AND stamped would recreate the
 * premature-marker problem the runbook ordering exists to prevent.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

const dbPath = path.join(DATA_DIR, 'v2.db');
const checkOnly = process.argv.includes('--check');

function appliedNames(): Set<string> {
  try {
    const rows = getDb()
      .prepare("SELECT name FROM schema_version")
      .all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    // Table absent on a fresh DB — nothing applied yet.
    return new Set();
  }
}

function main(): void {
  initDb(dbPath);
  try {
    const before = appliedNames();

    if (checkOnly) {
      process.stdout.write(
        `${dbPath}\n${before.size} migration(s) already applied; --check applied nothing.\n`,
      );
      return;
    }

    runMigrations(getDb());
    const after = appliedNames();
    const added = [...after].filter((n) => !before.has(n));

    process.stdout.write(
      [
        dbPath,
        `applied ${added.length} migration(s)${added.length ? `: ${added.join(', ')}` : ''}`,
        `${after.size} total`,
        '',
        'The upgrade marker was NOT stamped — that stays the last step of the runbook.',
        '',
      ].join('\n'),
    );
  } finally {
    closeDb();
  }
}

main();
