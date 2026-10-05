/**
 * run_failure_alert: a failing scheduled task's alert reaches the admin/owner
 * DM as one plain chat — no model, no approval card. Setup mirrors
 * primitive.test.ts: real central DB, fake delivery adapter.
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
const session: Session = {
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

let sent: Array<{ channelType: string; platformId: string; kind: string; text: string }>;

beforeEach(async () => {
  sent = [];
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'Smithy', folder: 'smithy', agent_provider: null, created_at: now() });
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

  it('delivers one plain chat to the owner DM, attributed to the agent group', async () => {
    await action()({ action: 'run_failure_alert', text: 'Scheduled task "x" has failed 2 runs in a row.' }, session);

    expect(sent).toEqual([
      {
        channelType: 'slack',
        platformId: 'D-owner-1',
        kind: 'chat',
        text: '⚠️ Smithy: Scheduled task "x" has failed 2 runs in a row.',
      },
    ]);
  });

  it('appends NANOCLAW_AUTH_FAILURE_HINT to credential-rejection alerts only', async () => {
    process.env.NANOCLAW_AUTH_FAILURE_HINT = 'Replace the model secret in the credential vault.';

    await action()({ action: 'run_failure_alert', text: 'credential rejected', authFailure: true }, session);
    await action()({ action: 'run_failure_alert', text: 'failed twice', authFailure: false }, session);

    expect(sent.map((s) => s.text)).toEqual([
      '⚠️ Smithy: credential rejected\nReplace the model secret in the credential vault.',
      '⚠️ Smithy: failed twice',
    ]);
  });

  it('drops an empty alert and caps a long one', async () => {
    await action()({ action: 'run_failure_alert', text: '   ' }, session);
    expect(sent).toHaveLength(0);

    await action()({ action: 'run_failure_alert', text: 'y'.repeat(5000) }, session);
    expect(sent[0].text.length).toBeLessThan(1100);
  });
});
