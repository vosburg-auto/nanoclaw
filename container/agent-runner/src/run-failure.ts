/**
 * Run-failure visibility: classify a failed agent turn, word its notice, and
 * decide when a failing scheduled task warrants an out-of-band alert.
 *
 * A failed chat turn already tells its human (the poll loop's error notice).
 * A failed TASK run has nobody on the other end — its text only reaches the
 * run log — so a streak of them is reported as a `run_failure_alert` system
 * row, which the host delivers as plain text to the agent group's admin or
 * owner DM. No model call is involved anywhere on that path: the model (or
 * its credential) may be exactly what is broken.
 *
 * Policy: alert at once on an auth-class failure (a rejected credential never
 * heals by itself), otherwise after 2 consecutive failed task runs; at most
 * one alert per streak. The streak lives in session_state, so a container
 * restart mid-streak neither re-alerts nor forgets; any successful turn (chat
 * or task) clears it.
 */
import { getAgentMailbox } from './mailbox/index.js';
import { writeMessageOut } from './db/messages-out.js';
import { getTaskSeriesId } from './db/session-routing.js';

export const GENERIC_FAILURE_NOTICE = 'The agent run failed. Check the logs for details.';

/** Consecutive failed task runs that alert when none of them was auth-class. */
export const FAILURE_ALERT_STREAK = 2;

const STREAK_KEY = 'run_failure_streak';
const MAX_QUOTED_ERROR = 200;

// Auth-class: the model provider rejected the credential itself. Deliberately
// narrow — a 403 alone is often billing or permissions, which a new credential
// does not fix, so it only counts alongside auth wording.
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /authentication_error/i,
  /\b(?:api error|http|status(?: code)?)[: ]+401\b/i,
  /\b401\b[^\n]{0,20}unauthori[sz]ed/i,
  /\b403\b[^\n]*\b(?:authenticat\w*|oauth|credentials?)\b/i,
  /\b(?:token|api[ -]?key|credential)s?\b[^\n.]{0,40}\b(?:revoked|expired)\b/i,
  /\binvalid\b[^\n.]{0,20}\b(?:api[ -]?key|x-api-key|token|credential)s?\b/i,
];

/** True when this error text says the model provider rejected the credential. */
export function isAuthFailure(text: string | null | undefined): boolean {
  return !!text && AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

/**
 * The short auth error to quote, or null when none of `texts` is auth-class:
 * only the first matching line, whitespace-collapsed, bearer/key-looking
 * strings masked, capped — never the surrounding diagnostics.
 */
export function authFailureDetail(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!isAuthFailure(text)) continue;
    const line = text!.split('\n').find((l) => isAuthFailure(l)) ?? text!;
    const short = line
      .replace(/\b(?:bearer\s+\S+|sk-[\w-]{8,})/gi, '[redacted]')
      .replace(/\s+/g, ' ')
      .trim();
    return short.length > MAX_QUOTED_ERROR ? `${short.slice(0, MAX_QUOTED_ERROR - 1)}…` : short;
  }
  return null;
}

export function authFailureNotice(detail: string): string {
  return (
    `The model provider rejected this agent's credential: "${detail}". ` +
    'The credential needs replacing — restarting the agent will not fix it.'
  );
}

/** Chat notice for a failed turn: the auth wording when auth-class, else the provider error or the generic text. */
export function failureNotice(error: string | undefined, text?: string | null): string {
  const auth = authFailureDetail(error, text);
  return auth ? authFailureNotice(auth) : (error ?? GENERIC_FAILURE_NOTICE);
}

export interface FailureStreak {
  failures: number;
  alerted: boolean;
}

/**
 * Pure streak step. A success clears the streak; a failure extends it and
 * alerts exactly once per streak — at the first auth-class failure, or when
 * the streak reaches FAILURE_ALERT_STREAK.
 */
export function nextFailureStreak(
  prev: FailureStreak | null,
  outcome: { failed: boolean; auth: boolean },
): { streak: FailureStreak | null; alert: boolean } {
  if (!outcome.failed) return { streak: null, alert: false };
  const failures = (prev?.failures ?? 0) + 1;
  const alert = !prev?.alerted && (outcome.auth || failures >= FAILURE_ALERT_STREAK);
  return { streak: { failures, alerted: (prev?.alerted ?? false) || alert }, alert };
}

function readStreak(): FailureStreak | null {
  const raw = getAgentMailbox().operations.getState(STREAK_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FailureStreak>;
    return { failures: Number(parsed.failures) || 0, alerted: parsed.alerted === true };
  } catch {
    return null;
  }
}

function alertText(failures: number, authDetail: string | null): string {
  const series = getTaskSeriesId();
  const subject = series ? `Scheduled task "${series}"` : 'A scheduled task';
  if (authDetail) return `${subject} failed. ${authFailureNotice(authDetail)}`;
  const where = series ? ` (\`ncl tasks get ${series}\` shows the run log)` : '';
  return `${subject} has failed ${failures} runs in a row. Check the logs for details${where}.`;
}

/**
 * Record one turn's outcome against the session's failure streak and write
 * the alert row when the policy says so. Failed chat turns neither count nor
 * reset — their human already got a notice. Never throws: visibility
 * bookkeeping must not fail the turn it describes.
 */
export async function recordRunOutcome(outcome: {
  failed: boolean;
  taskRun: boolean;
  texts?: Array<string | null | undefined>;
}): Promise<void> {
  if (outcome.failed && !outcome.taskRun) return;
  try {
    const prev = readStreak();
    if (!outcome.failed && !prev) return;
    const authDetail = outcome.failed ? authFailureDetail(...(outcome.texts ?? [])) : null;
    const { streak, alert } = nextFailureStreak(prev, { failed: outcome.failed, auth: authDetail !== null });
    // Alert before persisting `alerted`: a lost write re-alerts next run
    // rather than never alerting.
    if (alert && streak) {
      await writeMessageOut({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'system',
        content: JSON.stringify({
          action: 'run_failure_alert',
          text: alertText(streak.failures, authDetail),
          authFailure: authDetail !== null,
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
