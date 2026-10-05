/**
 * `run_failure_alert` delivery action — the host half of run-failure
 * visibility (the agent-runner's run-failure.ts decides WHEN to alert).
 *
 * A failing scheduled task has no chat to report into, and the agent's model
 * may itself be what is broken, so the runner cannot ask the agent to say
 * anything. It writes this system row instead, carrying only facts
 * (`authFailure`, a short quoted `detail`). The host words the notice from its
 * own template — agent group name, series id, its own count of failed runs —
 * and sends it to the same admin/owner DM an approval card would reach
 * (pickApprover → pickApprovalDelivery). No model call.
 *
 * The row is agent-writable, so the host trusts it only as far as it can
 * check it: it delivers only from a task session whose latest settled
 * occurrence is a host-observed 'failed:agent' run, quotes at most one short
 * masked line, and sends at most one alert per session per hour.
 *
 * NANOCLAW_AUTH_FAILURE_HINT (host env or .env), when set, is appended to
 * credential-rejection alerts — e.g. where this install's model credential
 * is managed.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { isTaskThread, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

const MAX_DETAIL = 200;

/**
 * Per-session floor between alerts. In memory on purpose: it only backstops a
 * misbehaving or forged producer (the runner already dedupes, persistently,
 * to one alert per streak per 24h), and a host restart forgetting it costs at
 * most one extra alert — not worth a central-DB table.
 */
export const ALERT_MIN_INTERVAL_MS = 60 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

/** For tests. */
export function _resetRunFailureAlertRateLimit(): void {
  lastAlertAt.clear();
}

/** One line, bearer/key-looking strings masked, capped. */
function quotedDetail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const line = value
    .replace(/\b(?:bearer\s+\S+|sk-[\w-]{8,})/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

export async function deliverRunFailureAlert(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!isTaskThread(session.thread_id)) {
    log.warn('run_failure_alert from a non-task session — dropping', { sessionId: session.id });
    return;
  }
  const last = lastAlertAt.get(session.id);
  if (last !== undefined && Date.now() - last < ALERT_MIN_INTERVAL_MS) {
    log.warn('run_failure_alert rate-limited (one per session per hour) — dropping', { sessionId: session.id });
    return;
  }
  // Host-observed evidence: sync the runner's acks (idempotent, as the sweep
  // does) and count the session's trailing failed agent runs.
  const failures =
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      return mailbox.trailingAgentFailures();
    })) ?? 0;
  if (failures === 0) {
    log.warn('run_failure_alert without a failed agent run on record — dropping', { sessionId: session.id });
    return;
  }

  const seriesId = session.thread_id!.slice(TASKS_SYSTEM_THREAD_ID.length + 1);
  const series = seriesId ? `scheduled task "${seriesId}"` : 'a scheduled task';
  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  const detail = quotedDetail(content.detail);
  let body: string;
  if (content.authFailure === true) {
    const hint = (process.env.NANOCLAW_AUTH_FAILURE_HINT || envValue('NANOCLAW_AUTH_FAILURE_HINT') || '').trim();
    body =
      `⚠️ ${agentName}: ${series} failed — the model provider rejected the agent's credential` +
      `${detail ? `: "${detail}"` : ''}. The credential needs replacing; restarting the agent will not fix it.` +
      `${hint ? `\n${hint}` : ''}`;
  } else {
    body =
      `⚠️ ${agentName}: ${series} has failed ${failures} run${failures === 1 ? '' : 's'} in a row` +
      `${detail ? `: "${detail}"` : ''}.${seriesId ? ` Run log: \`ncl tasks get ${seriesId}\`.` : ''}`;
  }

  const adapter = getDeliveryAdapter();
  const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const target = await pickApprovalDelivery(
    await pickApprover(session.agent_group_id),
    origin?.channel_type ?? '',
    origin?.instance,
  );
  if (!adapter || !target) {
    // Throw rather than return: the delivery loop then records the row as a
    // failed delivery (bounded retries) instead of marking it delivered.
    throw new Error(`run_failure_alert: no reachable admin or owner DM for agent group ${session.agent_group_id}`);
  }
  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat',
    JSON.stringify({ text: body }),
    undefined,
    target.messagingGroup.instance,
  );
  lastAlertAt.set(session.id, Date.now());
  log.warn('Run-failure alert delivered', { sessionId: session.id, to: target.userId, failures });
}

registerDeliveryAction(
  'run_failure_alert',
  deliverRunFailureAlert,
  unguarded(
    'notice only: fixed host template to the group approver chain, sent only for a host-observed failed agent ' +
      'run in a task session, at most one per session per hour; the row contributes one short masked quote',
  ),
);
