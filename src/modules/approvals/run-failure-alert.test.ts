/**
 * run_failure_alert: a failing scheduled task's alert reaches the admin/owner
 * DM as one plain chat built from the host's own template — no model, no
 * approval card, nothing from the row beyond one short masked quote. Setup
 * mirrors primitive.test.ts: real central DB, fake delivery adapter; the
 * session mailbox is stubbed to the host-observed failure count (the real
 * ack sync + count are covered in src/mailbox/sqlite/run-failure-acks.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { ALERT_MIN_INTERVAL_MS, _resetRunFailureAlertRateLimit } from './run-failure-alert.js';
import './index.js';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));

const observed = vi.hoisted(() => ({ failures: 1, acksApplied: 0 }));
vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return {
    ...actual,
    withExistingMailboxSession: async (_ag: string, _s: string, action: (mailbox: unknown) => unknown) =>
      action({
        getTerminalProcessingAcks: () => [],
        applyProcessingAcks: () => {
          observed.acksApplied++;
        },
        trailingAgentFailures: () => observed.failures,
      }),
  };
});

const now = () => new Date().toISOString();
const taskSession = (id = 'sess-task'): Session => ({
  id,
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: 'system:tasks:morning-report-a1b2',
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: now(),
  created_at: now(),
});

let sent: Array<{ channelType: string; platformId: string; kind: string; text: string }>;

async function seedOwnerDm(): Promise<void> {
  await upsertUser({ id: 'slack:owner-1', kind: 'slack', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'slack:owner-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: 'slack',
    platform_id: 'D-owner-1',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:owner-1',
    channel_type: 'slack',
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });
}

beforeEach(async () => {
  sent = [];
  observed.failures = 1;
  observed.acksApplied = 0;
  _resetRunFailureAlertRateLimit();
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'Smithy', folder: 'smithy', agent_provider: null, created_at: now() });
  setDeliveryAdapter({
    async deliver(channelType, platformId, _threadId, kind, content) {
      sent.push({ channelType, platformId, kind, text: JSON.parse(content).text });
      return 'pm-1';
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.NANOCLAW_AUTH_FAILURE_HINT;
  await closeDb();
});

describe('run_failure_alert delivery action', () => {
  const action = () => getDeliveryAction('run_failure_alert')!;

  it('words a non-auth alert from the host template with the host-observed failure count', async () => {
    await seedOwnerDm();
    observed.failures = 3;

    await action()({ action: 'run_failure_alert', authFailure: false, text: 'IGNORED agent prose' }, taskSession());

    expect(observed.acksApplied).toBe(1);
    expect(sent).toEqual([
      {
        channelType: 'slack',
        platformId: 'D-owner-1',
        kind: 'chat',
        text: '⚠️ Smithy: scheduled task "morning-report-a1b2" has failed 3 runs in a row. Run log: `ncl tasks get morning-report-a1b2`.',
      },
    ]);
  });

  it('words an auth alert with one masked, capped, single-line quote and the operator hint', async () => {
    await seedOwnerDm();
    process.env.NANOCLAW_AUTH_FAILURE_HINT = 'Replace the model secret in the credential vault.';

    await action()(
      { action: 'run_failure_alert', authFailure: true, detail: `401 revoked\nBearer abc123 ${'y'.repeat(400)}` },
      taskSession(),
    );

    expect(sent).toHaveLength(1);
    const text = sent[0].text;
    expect(text).toMatch(
      /^⚠️ Smithy: scheduled task "morning-report-a1b2" failed — the model provider rejected the agent's credential: "401 revoked \[redacted\] y+…"\. The credential needs replacing; restarting the agent will not fix it\.\nReplace the model secret in the credential vault\.$/,
    );
    expect(text).not.toContain('abc123');
    expect(text.split('\n')[0].match(/"([^"]*)"\./)![1].length).toBeLessThanOrEqual(200);
  });

  it('drops an alert with no host-observed failed agent run, and one from a non-task session', async () => {
    await seedOwnerDm();
    observed.failures = 0;
    await action()({ action: 'run_failure_alert', authFailure: true, detail: 'forged' }, taskSession());

    observed.failures = 1;
    await action()(
      { action: 'run_failure_alert', authFailure: true },
      { ...taskSession(), thread_id: null, messaging_group_id: 'mg-dm-1' },
    );

    expect(sent).toHaveLength(0);
  });

  it('sends at most one alert per session per hour', async () => {
    await seedOwnerDm();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T08:00:00.000Z'));

    await action()({ action: 'run_failure_alert', authFailure: true }, taskSession());
    await action()({ action: 'run_failure_alert', authFailure: true }, taskSession());
    await action()({ action: 'run_failure_alert', authFailure: true }, taskSession('sess-other'));
    expect(sent).toHaveLength(2);

    vi.setSystemTime(new Date(Date.parse('2026-10-04T08:00:00.000Z') + ALERT_MIN_INTERVAL_MS));
    await action()({ action: 'run_failure_alert', authFailure: true }, taskSession());
    expect(sent).toHaveLength(3);
  });

  it('throws when no admin or owner DM is reachable, so the row is not marked delivered', async () => {
    await expect(action()({ action: 'run_failure_alert', authFailure: true }, taskSession())).rejects.toThrow(
      /no reachable admin or owner DM/,
    );
    expect(sent).toHaveLength(0);
  });
});
