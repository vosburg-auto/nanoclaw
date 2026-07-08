/**
 * Tests for `ncl groups config update --auto-compact-window` — the per-group
 * Claude Code auto-compact threshold (container_configs.auto_compact_window).
 *
 * Covers: set (positive integer), clear ("default" → NULL), rejection of
 * non-integer values, and the DB→container.json mapping via configFromDb().
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups-config' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups-config';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { configFromDb } from '../../container-config.js';
import type { AgentGroup } from '../../types.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including config update).
import './groups.js';

const GID = 'ag-acw';

function now(): string {
  return new Date().toISOString();
}

function group(): AgentGroup {
  return { id: GID, name: 'acw', folder: 'acw', agent_provider: null, created_at: now() };
}

async function configUpdate(args: Record<string, unknown>) {
  return dispatch({ id: 'req-acw', command: 'groups-config-update', args: { id: GID, ...args } }, { caller: 'host' });
}

describe('groups config update --auto-compact-window', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
    createAgentGroup(group());
    ensureContainerConfig(GID);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('sets a positive integer token count', async () => {
    const resp = await configUpdate({ 'auto-compact-window': '450000' });
    expect(resp.ok).toBe(true);

    const row = getContainerConfig(GID)!;
    expect(row.auto_compact_window).toBe(450000);
    // Materialized container.json carries the camelCase field.
    expect(configFromDb(row, group()).autoCompactWindow).toBe(450000);
  });

  it('clears back to provider default with "default"', async () => {
    await configUpdate({ 'auto-compact-window': '450000' });
    const resp = await configUpdate({ 'auto-compact-window': 'default' });
    expect(resp.ok).toBe(true);

    const row = getContainerConfig(GID)!;
    expect(row.auto_compact_window).toBeNull();
    // Unset in the materialized shape — the container falls back to its default.
    expect(configFromDb(row, group()).autoCompactWindow).toBeUndefined();
  });

  it('rejects non-integer and non-positive values', async () => {
    for (const bad of ['abc', '-1', '0', '1.5']) {
      const resp = await configUpdate({ 'auto-compact-window': bad });
      expect(resp.ok).toBe(false);
    }
    // Row untouched throughout.
    expect(getContainerConfig(GID)!.auto_compact_window).toBeNull();
    // Sanity: the DB default is genuinely NULL, so a fresh group inherits the
    // provider default rather than a schema-level constant.
    const raw = getDb().prepare('SELECT auto_compact_window FROM container_configs WHERE agent_group_id = ?').get(GID);
    expect(raw).toEqual({ auto_compact_window: null });
  });
});
