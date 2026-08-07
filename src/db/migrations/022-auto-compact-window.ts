import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// Renumbered 016 -> 022 in the v2.1.54 upstream sync: upstream took 016-021.
// `name` is the schema_version key and MUST stay 'auto-compact-window' —
// changing it would re-run the ALTER on installs that already applied it.
export const migration022: Migration = {
  version: 22,
  name: 'auto-compact-window',
  up(db: Database.Database) {
    // Per-group Claude Code auto-compact threshold (tokens). NULL = provider
    // default (the agent-runner's built-in 165000 or its env override).
    db.prepare('ALTER TABLE container_configs ADD COLUMN auto_compact_window INTEGER').run();
  },
};
