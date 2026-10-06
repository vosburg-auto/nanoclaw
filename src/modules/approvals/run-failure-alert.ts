/**
 * `run_failure_alert` delivery action — the host half of run-failure
 * visibility (the agent-runner's run-failure.ts decides WHEN to alert and
 * dedupes, persistently, to one alert per failure streak per 24h).
 *
 * A failing scheduled task has no chat to report into, and the agent's model
 * may itself be what is broken, so the runner cannot ask the agent to say
 * anything. It writes this system row instead. The host renders a fixed
 * template and sends it to the same admin/owner DM an approval card would
 * reach (pickApprover → pickApprovalDelivery). No model call.
 *
 * The alert is runner-attested: the container can write any row to its own
 * outbound DB, so nothing here proves a run failed, and the host does not
 * bound how many rows a session writes: a misbehaving agent can repeat the
 * fixed-template notice. That is accepted — an agent can already message its
 * own chat, and the notice carries no agent text. The runner's per-streak
 * 24h dedup bounds a well-behaved runner. The row contributes only
 * structured facts: `authFailure` picks the wording, `errorStatus` is shown
 * only as an integer HTTP status, `errorType` only from the fixed allowlist
 * below. No free text from the row ever reaches the DM.
 *
 * NANOCLAW_AUTH_FAILURE_HINT (host env or .env), when set, is appended to
 * credential-rejection alerts — e.g. where this install's model credential
 * is managed. It is the operator's own text.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { isTaskThread, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

// Provider error classes the alert may name (the Claude Agent SDK's
// SDKAssistantMessageError values). Anything else is omitted.
const ERROR_TYPES = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'cloud_credential_error',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
]);

/** " (HTTP 401, authentication_failed)" from the allowlisted structured facts, or ''. */
function errorFacts(content: Record<string, unknown>): string {
  const facts: string[] = [];
  const status = content.errorStatus;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    facts.push(`HTTP ${status}`);
  }
  if (typeof content.errorType === 'string' && ERROR_TYPES.has(content.errorType)) facts.push(content.errorType);
  return facts.length > 0 ? ` (${facts.join(', ')})` : '';
}

export async function deliverRunFailureAlert(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!isTaskThread(session.thread_id)) {
    log.warn('run_failure_alert from a non-task session — dropping', { sessionId: session.id });
    return;
  }
  const seriesId = session.thread_id!.slice(TASKS_SYSTEM_THREAD_ID.length + 1);
  const series = seriesId ? `scheduled task "${seriesId}"` : 'a scheduled task';
  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  const facts = errorFacts(content);
  let body: string;
  if (content.authFailure === true) {
    const hint = (process.env.NANOCLAW_AUTH_FAILURE_HINT || envValue('NANOCLAW_AUTH_FAILURE_HINT') || '').trim();
    body =
      `⚠️ ${agentName}: ${series} failed — the model provider rejected the agent's credential${facts}. ` +
      `The credential needs replacing; restarting the agent will not fix it.${hint ? `\n${hint}` : ''}`;
  } else {
    // The runner alerts a non-auth streak from its second failure on.
    body =
      `⚠️ ${agentName}: ${series} has failed at least 2 runs in a row${facts}.` +
      `${seriesId ? ` Run log: \`ncl tasks get ${seriesId}\`.` : ''}`;
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
  log.warn('Run-failure alert delivered', { sessionId: session.id, to: target.userId });
}

registerDeliveryAction(
  'run_failure_alert',
  deliverRunFailureAlert,
  unguarded(
    'runner-attested notice: a task session can send its approver chain fixed-template DMs (bounded only by the ' +
      "runner's per-streak dedup, not by the host); the row supplies only structured facts, never free text",
  ),
);
