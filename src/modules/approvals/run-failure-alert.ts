/**
 * `run_failure_alert` delivery action — the host half of run-failure
 * visibility (the agent-runner's run-failure.ts decides WHEN to alert).
 *
 * A failing scheduled task has no chat to report into, and the agent's model
 * may itself be what is broken, so the runner cannot ask the agent to say
 * anything. It writes this system row instead; the host relays its text,
 * attributed to the agent group, to the same admin/owner DM an approval card
 * would reach (pickApprover → pickApprovalDelivery). No model call.
 *
 * NANOCLAW_AUTH_FAILURE_HINT (host env or .env), when set, is appended to
 * credential-rejection alerts — e.g. where this install's model credential
 * is managed.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

const MAX_ALERT_TEXT = 1000;

export async function deliverRunFailureAlert(content: Record<string, unknown>, session: Session): Promise<void> {
  const text = typeof content.text === 'string' ? content.text.trim().slice(0, MAX_ALERT_TEXT) : '';
  if (!text) {
    log.warn('run_failure_alert without text — dropping', { sessionId: session.id });
    return;
  }
  const adapter = getDeliveryAdapter();
  const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const target = await pickApprovalDelivery(
    await pickApprover(session.agent_group_id),
    origin?.channel_type ?? '',
    origin?.instance,
  );
  if (!adapter || !target) {
    log.error('Run-failure alert has no reachable admin or owner DM — not delivered', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      text,
    });
    return;
  }
  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  const hint =
    content.authFailure === true
      ? (process.env.NANOCLAW_AUTH_FAILURE_HINT || envValue('NANOCLAW_AUTH_FAILURE_HINT') || '').trim()
      : '';
  const body = `⚠️ ${agentName}: ${text}${hint ? `\n${hint}` : ''}`;
  // Throws into the delivery retry path (bounded attempts) like any send.
  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat',
    JSON.stringify({ text: body }),
    undefined,
    target.messagingGroup.instance,
  );
  log.warn('Run-failure alert delivered', { sessionId: session.id, to: target.userId });
}

registerDeliveryAction(
  'run_failure_alert',
  deliverRunFailureAlert,
  unguarded('notice only: one plain DM to the group approver chain, text capped and attributed to the agent group'),
);
