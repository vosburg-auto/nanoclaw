/**
 * Run-failure visibility (orin-ops#700): a failed agent turn is acked
 * 'failed' — 'failed:auth' when the credential was rejected — so the host
 * counts it, and a failing scheduled task alerts its
 * admin out of band — once per streak, immediately when the credential was
 * rejected. Drives the REAL processQuery / runPollLoop call sites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { authFailureDetail, isAuthFailure, nextFailureStreak } from './run-failure.js';

// The incident's literal SDK result text.
const REVOKED = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  getInboundDb()
    .prepare(
      'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, NULL, NULL, ?)',
    )
    .run('system:tasks:morning-report-a1b2');
});
afterEach(() => closeSessionDb());

const TASK = { platformId: null, channelType: null, threadId: 'system:tasks:morning-report-a1b2', taskRun: true };
const CHAT = { platformId: 'chan-1', channelType: 'discord', threadId: null };

function oneResult(result: ProviderEvent): AgentQuery {
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return { push: () => {}, end: () => {}, events: events(), abort: () => {} };
}

/** One task occurrence through the real processQuery — each call is a fresh "container". */
async function taskRun(id: string, result: ProviderEvent): Promise<void> {
  await processQuery(oneResult(result), { ...TASK, inReplyTo: id }, [id], 'claude', undefined, 'prompt', undefined);
}

async function chatTurn(id: string, result: ProviderEvent): Promise<void> {
  await processQuery(oneResult(result), { ...CHAT, inReplyTo: id }, [id], 'claude', undefined, 'prompt', undefined);
}

function ackStatus(id: string): string | undefined {
  return (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;
}

function alerts(): Array<{ action: string; text: string; authFailure: boolean }> {
  return getUndeliveredMessages()
    .filter((row) => row.kind === 'system')
    .map((row) => JSON.parse(row.content))
    .filter((content) => content.action === 'run_failure_alert');
}

const authError: ProviderEvent = { type: 'result', text: REVOKED, isError: true };
const otherError: ProviderEvent = { type: 'result', text: 'API Error: 529 Overloaded', isError: true };
const success: ProviderEvent = { type: 'result', text: 'all quiet' };

describe('isAuthFailure', () => {
  it.each([
    REVOKED,
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'HTTP 401 Unauthorized',
    'OAuth token has expired. Please obtain a new token.',
    'Invalid API key · Please run /login',
    'API Error: 403 {"error":{"type":"forbidden","message":"OAuth authentication is not allowed for this organization"}}',
  ])('classifies %s as auth', (text) => {
    expect(isAuthFailure(text)).toBe(true);
  });

  it.each([
    '403 billing_error: Spending limit reached. Update your billing settings to continue.',
    'API Error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit',
    'API Error: 529 Overloaded',
    'API Error: 500 Internal server error',
    'Prompt is too long: 250000 tokens > 200000 maximum',
    'invalid_request_error: max_tokens: Invalid value for max_tokens',
    'OpenCode prompt failed: {"responseHeaders":{"authorization":"fixture-secret"}}',
    'Out of credits [seven_day]',
    '',
    null,
    undefined,
  ])('does not classify %s as auth', (text) => {
    expect(isAuthFailure(text)).toBe(false);
  });

  it('quotes only the matching line, masked and capped', () => {
    const detail = authFailureDetail(
      `stack line\nAuthorization: Bearer abc.def failed to authenticate ${'x'.repeat(300)}`,
    );
    expect(detail).not.toContain('stack line');
    expect(detail).not.toContain('abc.def');
    expect(detail!.length).toBeLessThanOrEqual(200);
    expect(authFailureDetail(undefined, 'API Error: 529 Overloaded')).toBeNull();
  });
});

describe('nextFailureStreak', () => {
  it('alerts once per streak: at once on auth, else at the second failure; success resets', () => {
    let s = nextFailureStreak(null, { failed: true, auth: false });
    expect(s).toEqual({ streak: { failures: 1, alerted: false }, alert: false });
    s = nextFailureStreak(s.streak, { failed: true, auth: false });
    expect(s).toEqual({ streak: { failures: 2, alerted: true }, alert: true });
    s = nextFailureStreak(s.streak, { failed: true, auth: true });
    expect(s.alert).toBe(false);
    expect(nextFailureStreak(s.streak, { failed: false, auth: false })).toEqual({ streak: null, alert: false });
    expect(nextFailureStreak(null, { failed: true, auth: true }).alert).toBe(true);
  });
});

describe('task run failures (real processQuery)', () => {
  it('a 401 result acks the occurrence failed:auth, logs it FAILED and alerts once with the credential wording', async () => {
    await taskRun('t1', authError);

    expect(ackStatus('t1')).toBe('failed:auth');
    const logs = getUndeliveredMessages().filter((row) => row.kind === 'task_log');
    expect(logs.map((row) => JSON.parse(row.content).text)).toEqual([`FAILED: ${REVOKED}`]);
    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].authFailure).toBe(true);
    expect(sent[0].text).toContain('Scheduled task "morning-report-a1b2" failed.');
    expect(sent[0].text).toContain(`rejected this agent's credential: "${REVOKED}"`);
    expect(sent[0].text).toContain('restarting the agent will not fix it');
    // Nothing reached a chat — task runs have no channel.
    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);
  });

  it('a second consecutive 401 (fresh container) does not alert again', async () => {
    await taskRun('t1', authError);
    await taskRun('t2', authError);

    expect(ackStatus('t2')).toBe('failed:auth');
    expect(alerts()).toHaveLength(1);
  });

  it('a successful run of any kind ends the streak, so the next failure streak alerts again', async () => {
    await taskRun('t1', authError);
    await chatTurn('m1', success);
    await taskRun('t2', authError);

    expect(alerts()).toHaveLength(2);
  });

  it('two consecutive non-auth errors alert once; a single one does not', async () => {
    await taskRun('t1', otherError);
    expect(alerts()).toHaveLength(0);

    await taskRun('t2', otherError);
    // Non-auth failures keep the plain status, so they feed the host's backoff streak.
    expect(ackStatus('t2')).toBe('failed');
    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].authFailure).toBe(false);
    expect(sent[0].text).toContain('has failed 2 runs in a row');
    // Diagnostics stay in the run log, not the alert.
    expect(sent[0].text).not.toContain('Overloaded');

    await taskRun('t3', otherError);
    expect(alerts()).toHaveLength(1);
  });

  it('a single error between successes never alerts', async () => {
    await taskRun('t1', otherError);
    await taskRun('t2', success);
    await taskRun('t3', otherError);

    expect(alerts()).toHaveLength(0);
  });

  it('a normal run is unchanged: acked completed, plain run log, no alert, no streak state', async () => {
    await taskRun('t1', success);

    expect(ackStatus('t1')).toBe('completed');
    expect(
      getUndeliveredMessages()
        .filter((row) => row.kind === 'task_log')
        .map((row) => JSON.parse(row.content).text),
    ).toEqual(['all quiet']);
    expect(alerts()).toHaveLength(0);
    expect(getOutboundDb().prepare("SELECT key FROM session_state WHERE key = 'run_failure_streak'").get()).toBeNull();
  });
});

describe('chat turn failures', () => {
  it('a 401 tells the chat the credential was rejected, acks failed, and raises no alert', async () => {
    await chatTurn('m1', authError);

    expect(ackStatus('m1')).toBe('failed:auth');
    const chats = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(chats).toHaveLength(1);
    expect(JSON.parse(chats[0].content).text).toBe(
      `The model provider rejected this agent's credential: "${REVOKED}". ` +
        'The credential needs replacing — restarting the agent will not fix it.',
    );
    expect(alerts()).toHaveLength(0);
  });

  it('a non-auth error keeps the generic notice', async () => {
    await chatTurn('m1', otherError);

    const chats = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(JSON.parse(chats[0].content).text).toBe('The agent run failed. Check the logs for details.');
  });
});

describe('runPollLoop acks', () => {
  function insertTask(id: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES (?, 'task', ?, 'pending', 1, ?)`,
      )
      .run(id, new Date().toISOString(), JSON.stringify({ prompt: 'run the report' }));
  }

  async function runOnce(events: () => AsyncGenerator<ProviderEvent>): Promise<void> {
    const controller = new AbortController();
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      onExchangeComplete: () => controller.abort(),
      query: () => ({ events: events(), push: () => {}, end: () => {}, abort: () => {} }),
    };
    await runPollLoop({ provider, providerName: 'mock', cwd: '/workspace/agent', signal: controller.signal });
  }

  it('the end-of-batch completion ack never overwrites a failed turn', async () => {
    insertTask('t1');
    await runOnce(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      yield authError;
    });

    expect(ackStatus('t1')).toBe('failed:auth');
    expect(alerts()).toHaveLength(1);
  });

  it('a task run whose query crashes is acked failed and counts toward the streak', async () => {
    insertTask('t1');
    await runOnce(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      throw new Error(REVOKED);
    });

    expect(ackStatus('t1')).toBe('failed:auth');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].authFailure).toBe(true);
  });
});
