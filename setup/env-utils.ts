/**
 * Fork patch (vosburg-auto): helper for writing `.env` with strict permissions.
 *
 * Use this instead of bare `fs.writeFileSync` so the perms don't drift back to
 * umask defaults (typically 0644 — world-readable) the next time setup or a
 * channel-install flow rewrites the file. `.env` holds bot tokens.
 *
 * `mode: 0o600` on writeFileSync is honored only when the file is CREATED;
 * existing files keep their old perms. So the helper also runs an explicit
 * `chmodSync(0o600)` to repair legacy 0644 files in place.
 *
 * Carried at every sync — upstream rewrites `set-env.ts`/`timezone.ts` back to
 * bare `writeFileSync`, and it did exactly that in v2.1.54. Guarded by
 * `env-utils.test.ts`. See docs/BRANCH-FORK-MAINTENANCE.md.
 */
import fs from 'fs';

export function writeSecretEnvFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
