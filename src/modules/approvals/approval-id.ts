/**
 * Fork patch (vosburg-auto): CSPRNG approval ids.
 *
 * Upstream generates approval ids with `Math.random().toString(36)` — ~41 bits
 * at the OneCLI card site and ~31 bits plus a guessable timestamp at the
 * primitive site. The id is a capability: a click carrying a valid pending id
 * resolves a credentialed action. `isAuthorizedApprovalClick` is the
 * load-bearing defense, but the id itself should not be brute-forceable if that
 * check is ever bypassed.
 *
 * This lives in its OWN fork-owned file rather than as two in-file hunks. Both
 * previous hunks were silently reverted by the v2.1.54 sync (upstream owns
 * `onecli-approvals.ts` and `primitive.ts`, so taking their copies dropped our
 * edits); a fork-owned module is one carry-forward item that a sync cannot
 * overwrite by taking an upstream file wholesale. Guarded by `approval-id.test.ts`.
 *
 * See docs/BRANCH-FORK-MAINTENANCE.md.
 */
import { randomBytes } from 'node:crypto';

/** Bytes of entropy per id. 16 bytes = 128 bits = 22 base64url chars. */
export const APPROVAL_ID_BYTES = 16;

/**
 * `<prefix>-<22 base64url chars>`.
 *
 * Keep prefixes SHORT — Telegram caps `callback_data` at 64 bytes and Chat SDK
 * wraps the id as `chat:{"a":"<id>","v":"<value>"}`, a 20-byte envelope. The
 * primitive's longest button value is `reject_with_reason` (18 bytes), leaving
 * 26 bytes for the id; 22 chars of base64url plus a 2-char prefix and separator
 * is exactly 25, matching the length of the upstream id this replaces. A 4-char
 * prefix (`appr-`) overflows by one byte — `approval-id.test.ts` pins this, and
 * caught it when this module was written.
 */
export function generateApprovalId(prefix: string): string {
  return `${prefix}-${randomBytes(APPROVAL_ID_BYTES).toString('base64url')}`;
}
