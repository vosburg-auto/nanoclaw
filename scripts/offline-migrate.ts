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
import { fileURLToPath } from 'url';

import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  FORCE_PERMS_ENV,
  assertHostNotRunning,
  assertPrivateDb,
  ensurePrivateDb,
  forced,
} from '../src/cli/offline-transport.js';

const dbPath = path.join(DATA_DIR, 'v2.db');
const checkOnly = process.argv.includes('--check');

export function appliedNames(): Set<string> {
  try {
    const rows = getDb().prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch (e: unknown) {
    // ONLY "the table isn't there yet" may read as "nothing applied". A blanket
    // catch here also swallowed SQLITE_BUSY and permission errors and reported
    // 0 applied — which, during a recovery, tells the operator the opposite of
    // the truth about a database it could not actually read. (Cross-model review.)
    const msg = String((e as Error)?.message ?? e);
    if (/no such table/i.test(msg)) return new Set();
    throw new Error(`could not read schema_version from ${dbPath}: ${msg}`);
  }
}

export function main(): void {
  // The SAME preconditions OfflineTransport.open() enforces, and MORE load-bearing
  // here: this path runs schema migrations. Migration 016 does a destructive
  // DROP + RENAME of messaging_groups with no down migration, so running it under
  // a live host — which holds prepared statements against the old schema — is the
  // worst version of the race. An earlier revision guarded only the transport,
  // which fixed the named instance and left the more dangerous entry point open;
  // a review consensus (five lenses, including a cross-family one) caught it.
  assertHostNotRunning();
  // The SHARED decision, not a hand-copy of it. An earlier revision duplicated
  // this check inline, which meant the legacy combined override waived the
  // privacy check here WITHOUT printing the "waives BOTH" warning that the
  // transport prints — the audit trail went missing on the entry point that
  // runs the destructive migration. Review consensus, three lenses.
  if (!forced(process.env, FORCE_PERMS_ENV)) assertPrivateDb(dbPath);
  initDb(dbPath);
  ensurePrivateDb(dbPath);
  try {
    const before = appliedNames();

    if (checkOnly) {
      process.stdout.write(`${dbPath}\n${before.size} migration(s) already applied; --check applied nothing.\n`);
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

// Main-guard: importing this module (from its test) must not touch a database,
// shell out, or exit. Mirrors the pattern the fork's .mjs scripts use.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
