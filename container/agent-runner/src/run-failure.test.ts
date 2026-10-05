/**
 * Run-failure visibility (orin-ops#700): a failed agent turn is acked
 * 'failed:agent' (so the host counts it, outside the script backoff streak),
 * and a failing scheduled task alerts its admin out of band — immediately when
 * the credential was rejected, else at the second failure; then at most once
 * per 24h while the streak lasts. Drives the REAL processQuery / runPollLoop
 * call sites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { FAILURE_REALERT_MS, authFailureDetail, isAuthFailure, nextFailureStreak } from './run-failure.js';

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

function alerts(): Array<{ action: string; authFailure: boolean; detail?: string }> {
  return getUndeliveredMessages()
    .filter((row) => row.kind === 'system')
    .map((row) => JSON.parse(row.content))
    .filter((content) => content.action === 'run_failure_alert');
}

const authError: ProviderEvent = { type: 'result', text: REVOKED, isError: true };
const otherError: ProviderEvent = { type: 'result', text: 'API Error: 529 Overloaded', isError: true };
const success: ProviderEvent = { type: 'result', text: 'all quiet' };

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the follow-up push');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function insertTask(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'task', ?, 'pending', 1, ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify({ prompt: 'run the report' }));
}

describe('isAuthFailure (text fallback)', () => {
  it.each([
    REVOKED,
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
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
    '400 invalid max tokens',
    'GitHub token was revoked',
    'HTTP 401 Unauthorized from https://api.github.com',
    'OpenCode prompt failed: {"responseHeaders":{"authorization":"fixture-secret"}}',
    'Out of credits [seven_day]',
    '',
    null,
    undefined,
  ])('does not classify %s as auth', (text) => {
    expect(isAuthFailure(text)).toBe(false);
  });
});

describe('authFailureDetail (structured signal first)', () => {
  it('auth from the structured signal alone: HTTP 401, or an auth error class (also on a 403)', () => {
    expect(authFailureDetail({ status: 401, texts: ['request failed'] })).toBe('request failed');
    expect(authFailureDetail({ errorType: 'authentication_failed', texts: [] })).toBe('authentication_failed');
    expect(authFailureDetail({ status: 403, errorType: 'oauth_org_not_allowed', texts: [] })).not.toBeNull();
  });

  it('a structured non-auth signal wins over auth-looking text', () => {
    expect(authFailureDetail({ status: 529, errorType: 'overloaded', texts: [REVOKED] })).toBeNull();
    expect(authFailureDetail({ status: 403, errorType: 'billing_error', texts: ['API Error: 403 oauth'] })).toBeNull();
    expect(authFailureDetail({ status: 403, texts: ['API Error: 403 OAuth authentication'] })).toBeNull();
  });

  it('falls back to the text only without a structured signal', () => {
    expect(authFailureDetail({ texts: [REVOKED] })).toBe(REVOKED);
    expect(authFailureDetail({ errorType: 'unknown', texts: [REVOKED] })).toBe(REVOKED);
    expect(authFailureDetail({ texts: ['API Error: 529 Overloaded'] })).toBeNull();
  });

  it('quotes only the auth line, masked and capped', () => {
    const detail = authFailureDetail({
      texts: [`stack line\nAuthorization: Bearer abc.def failed to authenticate ${'x'.repeat(300)}`],
    });
    expect(detail).not.toContain('stack line');
    expect(detail).not.toContain('abc.def');
    expect(detail!.length).toBeLessThanOrEqual(200);
  });
});

describe('nextFailureStreak', () => {
  const t0 = Date.parse('2026-10-03T20:14:00.000Z');

  it('alerts at once on auth, else at the second failure; success resets', () => {
    let s = nextFailureStreak(null, { failed: true, auth: false }, t0);
    expect(s).toEqual({ streak: { failures: 1, lastAlertAt: null }, alert: false });
    s = nextFailureStreak(s.streak, { failed: true, auth: false }, t0);
    expect(s).toEqual({ streak: { failures: 2, lastAlertAt: new Date(t0).toISOString() }, alert: true });
    expect(nextFailureStreak(s.streak, { failed: false, auth: false }, t0)).toEqual({ streak: null, alert: false });
    expect(nextFailureStreak(null, { failed: true, auth: true }, t0).alert).toBe(true);
  });

  it('re-alerts a continuing streak only once 24h have passed since the last alert', () => {
    const first = nextFailureStreak(null, { failed: true, auth: true }, t0);
    const soon = nextFailureStreak(first.streak, { failed: true, auth: true }, t0 + FAILURE_REALERT_MS - 1);
    expect(soon.alert).toBe(false);
    expect(soon.streak!.lastAlertAt).toBe(new Date(t0).toISOString());
    const later = nextFailureStreak(soon.streak, { failed: true, auth: true }, t0 + FAILURE_REALERT_MS);
    expect(later.alert).toBe(true);
    expect(later.streak!.lastAlertAt).toBe(new Date(t0 + FAILURE_REALERT_MS).toISOString());
  });
});

describe('task run failures (real processQuery)', () => {
  it('a 401 result acks the occurrence failed:agent, logs it FAILED and writes one auth alert row', async () => {
    await taskRun('t1', authError);

    expect(ackStatus('t1')).toBe('failed:agent');
    const logs = getUndeliveredMessages().filter((row) => row.kind === 'task_log');
    expect(logs.map((row) => JSON.parse(row.content).text)).toEqual([`FAILED: ${REVOKED}`]);
    // Facts only — the host words the notice from its own template.
    expect(alerts()).toEqual([{ action: 'run_failure_alert', authFailure: true, detail: REVOKED }]);
    // Nothing reached a chat — task runs have no channel.
    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);
  });

  it('the provider structured signal alone makes a failure auth-class (status 401, or an auth error class)', async () => {
    await taskRun('t1', { type: 'result', text: 'request failed', isError: true, errorStatus: 401 });
    await taskRun('m9', success);
    await taskRun('t2', { type: 'result', text: null, isError: true, errorType: 'authentication_failed' });
    await taskRun('m10', success);
    // ...and a structured non-auth signal overrides auth-looking text.
    await taskRun('t3', { type: 'result', text: REVOKED, isError: true, errorStatus: 529, errorType: 'overloaded' });

    expect(alerts()).toEqual([
      { action: 'run_failure_alert', authFailure: true, detail: 'request failed' },
      { action: 'run_failure_alert', authFailure: true, detail: 'authentication_failed' },
    ]);
  });

  it('a second consecutive 401 (fresh container) does not alert again', async () => {
    await taskRun('t1', authError);
    await taskRun('t2', authError);

    expect(ackStatus('t2')).toBe('failed:agent');
    expect(alerts()).toHaveLength(1);
  });

  it('a streak still failing 24h after its alert alerts again (a lost delivery is not final)', async () => {
    await taskRun('t1', authError);
    const state = getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'run_failure_streak'").get() as {
      value: string;
    };
    const streak = JSON.parse(state.value) as { failures: number; lastAlertAt: string };
    streak.lastAlertAt = new Date(Date.now() - FAILURE_REALERT_MS - 1000).toISOString();
    getOutboundDb()
      .prepare("UPDATE session_state SET value = ? WHERE key = 'run_failure_streak'")
      .run(JSON.stringify(streak));

    await taskRun('t2', authError);

    expect(alerts()).toHaveLength(2);
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
    expect(ackStatus('t2')).toBe('failed:agent');
    // Diagnostics stay in the run log, not the alert.
    expect(alerts()).toEqual([{ action: 'run_failure_alert', authFailure: false }]);

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

    expect(ackStatus('m1')).toBe('failed:agent');
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

    expect(ackStatus('t1')).toBe('failed:agent');
    expect(alerts()).toHaveLength(1);
  });

  it('a task run whose query crashes is acked failed and counts toward the streak', async () => {
    insertTask('t1');
    await runOnce(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      throw new Error(REVOKED);
    });

    expect(ackStatus('t1')).toBe('failed:agent');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].authFailure).toBe(true);
  });
});

describe('follow-up and abandoned turns (real processQuery, warm query)', () => {
  function warmQuery(events: (pushes: string[]) => AsyncGenerator<ProviderEvent>): {
    query: AgentQuery;
    pushes: string[];
  } {
    const pushes: string[] = [];
    return {
      pushes,
      query: { push: (m) => pushes.push(m), end: () => {}, events: events(pushes), abort: () => {} },
    };
  }

  it('success, then a follow-up whose result errors: first batch completed, follow-up failed:agent', async () => {
    const { query } = warmQuery(async function* (pushes) {
      yield { type: 'init', continuation: 'sess-1' };
      yield success;
      insertTask('t2');
      await waitFor(() => pushes.length === 1);
      // Acked completed at push time — the error must override it.
      expect(ackStatus('t2')).toBe('completed');
      yield otherError;
    });

    await processQuery(query, { ...TASK, inReplyTo: 't1' }, ['t1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('t1')).toBe('completed');
    expect(ackStatus('t2')).toBe('failed:agent');
  });

  it('a follow-up queued behind an answering turn, whose own result errors, is acked failed:agent', async () => {
    const { query } = warmQuery(async function* (pushes) {
      yield { type: 'init', continuation: 'sess-1' };
      insertTask('t2');
      await waitFor(() => pushes.length === 1);
      yield success; // answers t1
      yield otherError; // answers queued t2
    });

    await processQuery(query, { ...TASK, inReplyTo: 't1' }, ['t1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('t1')).toBe('completed');
    expect(ackStatus('t2')).toBe('failed:agent');
  });

  it('a crash with a queued turn acks both the answering and the queued batch failed:agent', async () => {
    const { query } = warmQuery(async function* (pushes) {
      yield { type: 'init', continuation: 'sess-1' };
      insertTask('t2');
      await waitFor(() => pushes.length === 1);
      throw new Error('API Error: 529 Overloaded');
    });

    await expect(
      processQuery(query, { ...TASK, inReplyTo: 't1' }, ['t1'], 'claude', undefined, 'prompt', undefined),
    ).rejects.toThrow('Overloaded');

    expect(ackStatus('t1')).toBe('failed:agent');
    expect(ackStatus('t2')).toBe('failed:agent');
  });
});
