import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'auto-compact-window',
  up(db: Database.Database) {
    // Per-group Claude Code auto-compact threshold (tokens). NULL = provider
    // default (the agent-runner's built-in 165000 or its env override).
    db.prepare('ALTER TABLE container_configs ADD COLUMN auto_compact_window INTEGER').run();
  },
};
