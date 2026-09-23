// Per-test-file private TMPDIR root, registered via `setupFiles` in
// vitest.config.ts (src/test/tmp-hygiene.test.ts enforces the registration).
//
// Before this, one `vitest run` left ~330 directories in the system tmpdir
// (nc-skill-*, nc-proj-*, ...): fixtures called mkdtempSync(tmpdir()) and never
// removed them; ~4,268 had accumulated on devops-vm. Rather than hand-add
// cleanup to every fixture, each test file gets one private root: os.tmpdir()
// reads TMPDIR on every call and spawned children inherit process.env, so every
// fixture and every child's `mktemp` lands inside, and afterAll removes it.
//
// Pool semantics: vitest's default pool here is `forks` (child processes), so
// process.env is per-worker-process; setup files re-run per test file inside a
// reused worker, which is why the ORIGINAL parent is pinned in
// NC_TEST_TMP_PARENT and TMPDIR is restored in afterAll. Under `threads`,
// process.env is shared by all workers of the process and this would race.
//
// A SIGKILLed run still leaks, but as ONE `nc-test-*` dir per file, and the
// age-gated sweep below reclaims those on a later run.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export const TMP_PREFIX = 'nc-test-';
const STALE_MS = 6 * 60 * 60 * 1000;

const parent = (process.env.NC_TEST_TMP_PARENT ??= tmpdir());

try {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const p = join(parent, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true });
    } catch {
      /* raced with another sweeper, or not ours */
    }
  }
} catch {
  /* unreadable parent: skip the sweep, never fail the suite on it */
}

const root = mkdtempSync(join(parent, TMP_PREFIX));
process.env.NC_TEST_TMP_ROOT = root;
process.env.TMPDIR = root;

afterAll(() => {
  process.env.TMPDIR = parent;
  delete process.env.NC_TEST_TMP_ROOT;
  rmSync(root, { recursive: true, force: true });
});
