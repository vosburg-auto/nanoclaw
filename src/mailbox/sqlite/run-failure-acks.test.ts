/**
 * A runner 'failed:agent' ack — an agent run that ended in an error — lands
 * the occurrence as a failed run (orin-ops#700). Before this, only
 * `script-skip:error` mapped to failed and every errored agent run was
 * recorded `completed`, so `ncl tasks list` showed 0 failures through a
 * 20-hour credential outage. Agent failures stay out of the pre-task-script
 * backoff/auto-pause streak, so a series resumes on its own schedule once the
 * provider or credential recovers.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, openInboundDb, syncProcessingAcks } from './session-db.js';
import { insertTaskRow } from './tasks.js';
import { wrapSqliteInbound } from './index.js';
import { handleRecurrence } from '../../modules/scheduling/recurrence.js';
import { parseProcessingAckRecord } from '../model.js';
import type { Session } from '../../types.js';

vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: () => ({ timezone: null }) }));

const TEST_DIR = '/tmp/nanoclaw-run-failure-acks-test';

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const inPath = path.join(TEST_DIR, 'inbound.db');
  ensureSchema(inPath, 'inbound');
  const db = openInboundDb(inPath);
  insertTaskRow(db, {
    id: 'task-1',
    seriesId: 'task-1',
    processAfter: '2020-01-01T00:00:00.000Z',
    recurrence: '0 9 * * *',
    content: JSON.stringify({ prompt: 'morning report' }),
  });
  db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'task-1'").run();
  return db;
}

const statusOf = (db: Database.Database, id: string) =>
  (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;

type AckStatus = 'completed' | 'failed:agent' | 'script-skip:error';
const ack = (status: AckStatus, messageId = 'task-1') => [
  parseProcessingAckRecord({ messageId, status, statusChanged: new Date().toISOString() }),
];

const session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: 'system:tasks:task-1',
  status: 'active',
  created_at: new Date().toISOString(),
  last_active: new Date().toISOString(),
  container_status: 'stopped',
} as Session;

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe("runner 'failed:agent' ack", () => {
  it('marks the occurrence failed:agent and counts it in failed_runs', () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);

    inbound.applyProcessingAcks(ack('failed:agent'));

    expect(statusOf(db, 'task-1')).toBe('failed:agent');
    expect(inbound.getTaskStats('task-1')).toMatchObject({ runs: 0, failedRuns: 1 });
  });

  it('overrides an already-synced completed ack (warm follow-ups are acked at push time)', () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);

    inbound.applyProcessingAcks(ack('completed'));
    expect(statusOf(db, 'task-1')).toBe('completed');
    inbound.applyProcessingAcks(ack('failed:agent'));

    expect(statusOf(db, 'task-1')).toBe('failed:agent');
    expect(inbound.getTaskStats('task-1')).toMatchObject({ runs: 0, failedRuns: 1 });
  });

  it('never flips a failed agent run back to completed', () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);

    inbound.applyProcessingAcks(ack('failed:agent'));
    inbound.applyProcessingAcks(ack('completed'));

    expect(statusOf(db, 'task-1')).toBe('failed:agent');
  });

  it('a completed ack is unchanged: completed, counted as a run', () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);

    inbound.applyProcessingAcks(ack('completed'));

    expect(statusOf(db, 'task-1')).toBe('completed');
    expect(inbound.getTaskStats('task-1')).toMatchObject({ runs: 1, failedRuns: 0 });
  });

  it('the legacy syncProcessingAcks path maps it the same way', () => {
    const db = freshDb();
    const outPath = path.join(TEST_DIR, 'outbound.db');
    ensureSchema(outPath, 'outbound');
    const outDb = new Database(outPath);
    outDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('task-1', 'failed:agent', new Date().toISOString());

    syncProcessingAcks(db, outDb);
    outDb.close();

    expect(statusOf(db, 'task-1')).toBe('failed:agent');
  });

  it('a failed recurring occurrence still re-arms the series', async () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);
    inbound.applyProcessingAcks(ack('failed:agent'));

    await handleRecurrence(inbound, session);

    const rows = db
      .prepare("SELECT id, status, recurrence FROM messages_in WHERE series_id = 'task-1' ORDER BY seq")
      .all() as Array<{ id: string; status: string; recurrence: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'task-1', status: 'failed:agent', recurrence: null });
    expect(rows[1]).toMatchObject({ status: 'pending', recurrence: '0 9 * * *' });
  });

  it('trailingAgentFailures counts the trailing failed agent runs, stopping at any other settled run', () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);
    expect(inbound.trailingAgentFailures()).toBe(0);
    for (const [i, status] of (['failed:agent', 'completed', 'failed:agent', 'failed:agent'] as const).entries()) {
      insertTaskRow(db, {
        id: `occ-${i}`,
        seriesId: 'task-1',
        processAfter: '2020-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'morning report' }),
      });
      inbound.applyProcessingAcks(ack(status, `occ-${i}`));
    }
    expect(inbound.trailingAgentFailures()).toBe(2);
    inbound.applyProcessingAcks(ack('script-skip:error', 'task-1'));
    expect(inbound.trailingAgentFailures()).toBe(2); // task-1 is the OLDEST row
  });
});

/**
 * Drive `runs` consecutive occurrences of an every-minute series through the
 * real ack sync + recurrence sweep, each acked `status`. Returns each re-armed
 * occurrence's status and how many minutes out it was scheduled.
 */
async function failConsecutively(status: 'failed:agent' | 'script-skip:error', runs: number) {
  const db = freshDb();
  db.prepare("UPDATE messages_in SET recurrence = '* * * * *' WHERE id = 'task-1'").run();
  const inbound = wrapSqliteInbound(db);
  const armed: Array<{ status: string; minutesOut: number }> = [];
  let current = 'task-1';
  for (let i = 0; i < runs; i++) {
    inbound.applyProcessingAcks(ack(status, current));
    await handleRecurrence(inbound, session);
    const next = db
      .prepare("SELECT id, status, process_after FROM messages_in WHERE series_id = 'task-1' ORDER BY seq DESC LIMIT 1")
      .get() as { id: string; status: string; process_after: string };
    armed.push({ status: next.status, minutesOut: (Date.parse(next.process_after) - Date.now()) / 60_000 });
    if (next.status !== 'pending') break;
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = ?").run(next.id);
    current = next.id;
  }
  return { armed, stats: inbound.getTaskStats('task-1'), streak: inbound.trailingFailedRuns('task-1') };
}

describe('agent-run failures are exempt from the script backoff and auto-pause', () => {
  // Every agent-run failure — a 401 or a 529 alike — acks 'failed:agent'.
  it('ten consecutive failed agent runs re-arm on the plain cron every time and all count as failed runs', async () => {
    const { armed, stats, streak } = await failConsecutively('failed:agent', 10);

    expect(armed).toHaveLength(10);
    for (const next of armed) {
      expect(next.status).toBe('pending'); // never auto-paused
      expect(next.minutesOut).toBeLessThan(1.5); // raw every-minute cron, no backoff
    }
    expect(stats).toMatchObject({ runs: 0, failedRuns: 10 });
    expect(streak).toBe(0);
  });

  it('pre-task script failures still back off and auto-pause at 8, exactly as before', async () => {
    const { armed, stats, streak } = await failConsecutively('script-skip:error', 10);

    expect(armed[0]).toMatchObject({ status: 'pending' });
    expect(armed[0].minutesOut).toBeGreaterThan(1.5); // 2-min backoff beat the cron
    expect(armed.at(-1)?.status).toBe('paused');
    expect(armed).toHaveLength(8);
    expect(stats.failedRuns).toBe(8);
    expect(streak).toBe(8);
  });

  it('an agent failure neither counts toward nor breaks a script-failure streak', async () => {
    const db = freshDb();
    const inbound = wrapSqliteInbound(db);
    for (const [i, status] of (['script-skip:error', 'failed:agent', 'script-skip:error'] as const).entries()) {
      insertTaskRow(db, {
        id: `occ-${i}`,
        seriesId: 'task-1',
        processAfter: '2020-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'morning report' }),
      });
      inbound.applyProcessingAcks(ack(status, `occ-${i}`));
    }
    inbound.applyProcessingAcks(ack('failed:agent'));

    expect(statusOf(db, 'occ-1')).toBe('failed:agent');
    expect(inbound.trailingFailedRuns('task-1')).toBe(2);
    expect(inbound.getTaskStats('task-1').failedRuns).toBe(4);
  });
});
