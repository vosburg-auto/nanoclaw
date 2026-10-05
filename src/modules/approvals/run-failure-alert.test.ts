/**
 * run_failure_alert: a failing scheduled task's alert reaches the admin/owner
 * DM as one plain chat rendered from the host's fixed template — no model, no
 * approval card, and no free text from the (runner-attested) row: only the
 * auth flag, an allowlisted error class and an integer HTTP status. Setup
 * mirrors primitive.test.ts: real central DB, fake delivery adapter.
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
import './index.js';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));

const now = () => new Date().toISOString();
const taskSession: Session = {
  id: 'sess-task',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: 'system:tasks:morning-report-a1b2',
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: now(),
  created_at: now(),
};

const AUTH_TEXT =
  '⚠️ Smithy: scheduled task "morning-report-a1b2" failed — the model provider rejected the agent\'s credential' +
  '%FACTS%. The credential needs replacing; restarting the agent will not fix it.';
const STREAK_TEXT =
  '⚠️ Smithy: scheduled task "morning-report-a1b2" has failed at least 2 runs in a row%FACTS%. ' +
  'Run log: `ncl tasks get morning-report-a1b2`.';

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
  delete process.env.NANOCLAW_AUTH_FAILURE_HINT;
  await closeDb();
});

describe('run_failure_alert delivery action', () => {
  const action = () => getDeliveryAction('run_failure_alert')!;

  it('renders a non-auth alert from the fixed template to the owner DM', async () => {
    await seedOwnerDm();

    await action()({ action: 'run_failure_alert', authFailure: false }, taskSession);

    expect(sent).toEqual([
      { channelType: 'slack', platformId: 'D-owner-1', kind: 'chat', text: STREAK_TEXT.replace('%FACTS%', '') },
    ]);
  });

  it('renders an auth alert with the allowlisted facts and the operator hint', async () => {
    await seedOwnerDm();
    process.env.NANOCLAW_AUTH_FAILURE_HINT = 'Replace the model secret in the credential vault.';

    await action()(
      { action: 'run_failure_alert', authFailure: true, errorStatus: 401, errorType: 'authentication_failed' },
      taskSession,
    );
    await action()({ action: 'run_failure_alert', authFailure: false, errorStatus: 529 }, taskSession);

    expect(sent.map((s) => s.text)).toEqual([
      `${AUTH_TEXT.replace('%FACTS%', ' (HTTP 401, authentication_failed)')}\nReplace the model secret in the credential vault.`,
      STREAK_TEXT.replace('%FACTS%', ' (HTTP 529)'),
    ]);
  });

  it('never relays free text from the row: extra fields, an unlisted error class and a non-status number are omitted', async () => {
    await seedOwnerDm();

    await action()(
      {
        action: 'run_failure_alert',
        authFailure: true,
        text: 'INJECTED text',
        detail: 'INJECTED detail',
        errorType: 'INJECTED class',
        errorStatus: 401.5,
      },
      taskSession,
    );
    await action()(
      { action: 'run_failure_alert', authFailure: true, errorType: 'unknown', errorStatus: 999 },
      taskSession,
    );
    await action()({ action: 'run_failure_alert', authFailure: true, errorStatus: '401' }, taskSession);

    expect(sent.map((s) => s.text)).toEqual([
      AUTH_TEXT.replace('%FACTS%', ''),
      AUTH_TEXT.replace('%FACTS%', ''),
      AUTH_TEXT.replace('%FACTS%', ''),
    ]);
    expect(sent.map((s) => s.text).join('\n')).not.toContain('INJECTED');
  });

  it('has no host-side rate limit: a new streak right after the last alert is delivered too', async () => {
    await seedOwnerDm();

    // alert → (a successful run ends the streak in the runner) → a new streak's alert, minutes later
    await action()({ action: 'run_failure_alert', authFailure: true }, taskSession);
    await action()({ action: 'run_failure_alert', authFailure: false }, taskSession);

    expect(sent).toHaveLength(2);
  });

  it('drops an alert from a non-task session', async () => {
    await seedOwnerDm();

    await action()(
      { action: 'run_failure_alert', authFailure: true },
      { ...taskSession, thread_id: null, messaging_group_id: 'mg-dm-1' },
    );

    expect(sent).toHaveLength(0);
  });

  it('throws when no admin or owner DM is reachable, so the row is not marked delivered', async () => {
    await expect(action()({ action: 'run_failure_alert', authFailure: true }, taskSession)).rejects.toThrow(
      /no reachable admin or owner DM/,
    );
    expect(sent).toHaveLength(0);
  });
});
