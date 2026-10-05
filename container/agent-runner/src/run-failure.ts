/**
 * Run-failure visibility: classify a failed agent turn, word its notice, and
 * decide when a failing scheduled task warrants an out-of-band alert.
 *
 * A failed chat turn already tells its human (the poll loop's error notice).
 * A failed TASK run has nobody on the other end — its text only reaches the
 * run log — so a streak of them is reported as a `run_failure_alert` system
 * row. The host turns it into a fixed-template notice to the agent group's
 * admin or owner DM. No model call is involved anywhere on that path: the
 * model (or its credential) may be exactly what is broken.
 *
 * Policy: alert at once on an auth-class failure (a rejected credential never
 * heals by itself), otherwise after 2 consecutive failed task runs; while the
 * streak continues, at most one alert per 24h (a lost delivery is retried a
 * day later, not never). The streak lives in session_state, so a container
 * restart mid-streak neither re-alerts nor forgets; any successful turn (chat
 * or task) clears it.
 */
import { getAgentMailbox } from './mailbox/index.js';
import { writeMessageOut } from './db/messages-out.js';

export const GENERIC_FAILURE_NOTICE = 'The agent run failed. Check the logs for details.';

/** Consecutive failed task runs that alert when none of them was auth-class. */
export const FAILURE_ALERT_STREAK = 2;

/** While a streak continues, re-alert at most this often. */
export const FAILURE_REALERT_MS = 24 * 60 * 60 * 1000;

const STREAK_KEY = 'run_failure_streak';
const MAX_QUOTED_ERROR = 200;

// Provider error classes that mean the credential itself was refused
// (Claude Agent SDK `SDKAssistantMessageError`). 'billing_error',
// 'account_on_hold' etc. are not fixed by a new credential.
const AUTH_ERROR_TYPES = new Set(['authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error']);

// Text fallback, for providers (or SDK paths) without a structured signal.
// Anchored to the model API's own wording so an unrelated "token was revoked"
// from a tool, or "invalid max_tokens", never reads as a credential failure.
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /authentication_error/i,
  /\bapi error: 401\b/i,
  /\bapi error: 403\b[^\n]*\b(?:authentication|oauth)\b/i,
  /\boauth (?:access )?token\b[^\n.]{0,30}\b(?:revoked|expired)\b/i,
  /\binvalid (?:x-api-key|api key)\b/i,
];

/** Text-only fallback classifier: does this error text say the model provider rejected the credential? */
export function isAuthFailure(text: string | null | undefined): boolean {
  return !!text && AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

export interface FailureSignal {
  /** HTTP status of the failed model API call, when the provider reports one. */
  status?: number;
  /** Provider error class, when the provider reports one. */
  errorType?: string;
  /** Error and result texts, for the quoted detail and the regex fallback. */
  texts: Array<string | null | undefined>;
}

function shortLine(text: string): string {
  const short = text
    .replace(/\b(?:bearer\s+\S+|sk-[\w-]{8,})/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return short.length > MAX_QUOTED_ERROR ? `${short.slice(0, MAX_QUOTED_ERROR - 1)}…` : short;
}

/**
 * The short error to quote when this failure is auth-class, else null.
 * Structured signal first: an auth error class, or HTTP 401, is auth; any
 * other structured signal is not (a 403 counts only with an auth error
 * class). Only without one does the text fallback decide. The quote is one
 * line — the first auth-worded line, else the first non-empty one — masked
 * and capped, never the surrounding diagnostics.
 */
export function authFailureDetail(signal: FailureSignal): string | null {
  const texts = signal.texts.filter((t): t is string => !!t && t.trim() !== '');
  const structured = signal.status !== undefined || (!!signal.errorType && signal.errorType !== 'unknown');
  const auth =
    (!!signal.errorType && AUTH_ERROR_TYPES.has(signal.errorType)) ||
    signal.status === 401 ||
    (!structured && texts.some(isAuthFailure));
  if (!auth) return null;
  const lines = texts.flatMap((t) => t.split('\n')).filter((l) => l.trim() !== '');
  const line = lines.find((l) => isAuthFailure(l)) ?? lines[0] ?? signal.errorType ?? `HTTP ${signal.status}`;
  return shortLine(line);
}

export function authFailureNotice(detail: string): string {
  return (
    `The model provider rejected this agent's credential: "${detail}". ` +
    'The credential needs replacing — restarting the agent will not fix it.'
  );
}

/** Chat notice for a failed turn: the auth wording when auth-class, else the provider error or the generic text. */
export function failureNotice(authDetail: string | null, error: string | undefined): string {
  return authDetail ? authFailureNotice(authDetail) : (error ?? GENERIC_FAILURE_NOTICE);
}

export interface FailureStreak {
  failures: number;
  /** ISO time of the last alert written for this streak; null before the first. */
  lastAlertAt: string | null;
}

/**
 * Pure streak step. A success clears the streak; a failure extends it and
 * alerts once the streak qualifies (an auth-class failure, or
 * FAILURE_ALERT_STREAK failures) — then again only every FAILURE_REALERT_MS
 * while it lasts.
 */
export function nextFailureStreak(
  prev: FailureStreak | null,
  outcome: { failed: boolean; auth: boolean },
  nowMs: number,
): { streak: FailureStreak | null; alert: boolean } {
  if (!outcome.failed) return { streak: null, alert: false };
  const failures = (prev?.failures ?? 0) + 1;
  const last = prev?.lastAlertAt ? Date.parse(prev.lastAlertAt) : NaN;
  const due = Number.isNaN(last) || nowMs - last >= FAILURE_REALERT_MS;
  const alert = due && (outcome.auth || failures >= FAILURE_ALERT_STREAK);
  return {
    streak: { failures, lastAlertAt: alert ? new Date(nowMs).toISOString() : (prev?.lastAlertAt ?? null) },
    alert,
  };
}

function readStreak(): FailureStreak | null {
  const raw = getAgentMailbox().operations.getState(STREAK_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FailureStreak>;
    return {
      failures: Number(parsed.failures) || 0,
      lastAlertAt: typeof parsed.lastAlertAt === 'string' ? parsed.lastAlertAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Record one turn's outcome against the session's failure streak and write
 * the alert row when the policy says so. The row carries only whether the
 * failure was auth-class and its short quoted detail; the host words the
 * notice and counts the failures itself. Failed chat turns neither count nor
 * reset — their human already got a notice. Never throws: visibility
 * bookkeeping must not fail the turn it describes.
 */
export async function recordRunOutcome(outcome: {
  failed: boolean;
  taskRun: boolean;
  /** authFailureDetail() of the failure; null when not auth-class (or not failed). */
  authDetail?: string | null;
}): Promise<void> {
  if (outcome.failed && !outcome.taskRun) return;
  try {
    const prev = readStreak();
    if (!outcome.failed && !prev) return;
    const authDetail = outcome.failed ? (outcome.authDetail ?? null) : null;
    const { streak, alert } = nextFailureStreak(
      prev,
      { failed: outcome.failed, auth: authDetail !== null },
      Date.now(),
    );
    // Alert before persisting lastAlertAt: a lost write re-alerts next run
    // rather than never alerting.
    if (alert && streak) {
      await writeMessageOut({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'system',
        content: JSON.stringify({
          action: 'run_failure_alert',
          authFailure: authDetail !== null,
          ...(authDetail && { detail: authDetail }),
        }),
      });
      console.error(`[run-failure] Alert written after ${streak.failures} failed task run(s)`);
    }
    if (streak) getAgentMailbox().operations.setState(STREAK_KEY, JSON.stringify(streak));
    else getAgentMailbox().operations.deleteState(STREAK_KEY);
  } catch (err) {
    console.error(`[run-failure] Failed to record run outcome: ${err instanceof Error ? err.message : String(err)}`);
  }
}
