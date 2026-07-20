// Regression tests for bin/ncl — the CLI launcher's tsx-runner resolution.
//
// The launcher used to be `exec pnpm exec tsx src/cli/client.ts`, which made pnpm a HARD
// runtime dependency: on a host with deps installed but no pnpm on PATH (the deployed
// ss-smith-vm case) every invocation died with "exec: pnpm: not found", taking the
// documented operational commands down with it. It now resolves a runner instead of
// assuming one. These tests pin that resolution ORDER so a future edit cannot silently
// reintroduce the hard dependency or flip the precedence.
//
// Hermetic by construction: each case builds a throwaway project root containing a copy of
// bin/ncl, a stub client.ts, and FAKE `tsx` / `pnpm` executables that print a marker. We
// assert on the marker in stdout — i.e. on which runner actually got exec'd — rather than
// on `bash -x` trace output, so the tests exercise real behaviour and need neither a real
// pnpm nor a real tsx to be installed on the machine running them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REAL_NCL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ncl');

let root: string;
let fakeBin: string;

/** Write an executable shell stub that prints `marker` plus its args. */
function writeStub(path: string, marker: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\necho "${marker} $*"\n`);
  chmodSync(path, 0o755);
}

/**
 * Run the copied launcher. `pathDirs` becomes PATH, so pnpm's presence is controlled.
 *
 * spawnSync (not execFileSync) so BOTH streams are captured on every exit path. An earlier
 * revision returned a hardcoded `stderr: ''` on success, which silently made any stderr
 * assertion on a passing run vacuous — it could never fail regardless of what the launcher
 * actually wrote. Caught by the cross-model lens in panel review of #5.
 */
function runNcl(pathDirs: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(join(root, 'bin', 'ncl'), ['groups', 'list'], {
    encoding: 'utf8',
    env: { PATH: pathDirs.join(':'), HOME: root },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ncl-launcher-'));
  fakeBin = join(root, 'fakebin');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'src', 'cli'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  copyFileSync(REAL_NCL, join(root, 'bin', 'ncl'));
  chmodSync(join(root, 'bin', 'ncl'), 0o755);
  writeFileSync(join(root, 'src', 'cli', 'client.ts'), '// stub\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bin/ncl runner resolution', () => {
  it("prefers the checkout's own node_modules/.bin/tsx", () => {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeStub(join(root, 'node_modules', '.bin', 'tsx'), 'LOCAL_TSX');
    writeStub(join(fakeBin, 'pnpm'), 'PNPM'); // present but must NOT win

    const r = runNcl(['/usr/bin', '/bin', fakeBin]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LOCAL_TSX');
    expect(r.stdout).toContain('src/cli/client.ts groups list');
    // The regression this guards: pnpm must not be reached when a local tsx exists.
    expect(r.stdout).not.toContain('PNPM');
  });

  it('falls back to pnpm when there is no local tsx', () => {
    writeStub(join(fakeBin, 'pnpm'), 'PNPM');

    const r = runNcl(['/usr/bin', '/bin', fakeBin]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PNPM exec tsx src/cli/client.ts groups list');
  });

  it('fails loudly with a remedy when neither is available', () => {
    // The old launcher died here with a bare "exec: pnpm: not found".
    const r = runNcl(['/usr/bin', '/bin']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no tsx runner found/);
    expect(r.stderr).toMatch(/pnpm install|PATH/);
  });

  it('does not hard-require pnpm (the ss-smith-vm regression)', () => {
    // Deps installed, pnpm entirely absent from PATH — the exact deployed-host state.
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeStub(join(root, 'node_modules', '.bin', 'tsx'), 'LOCAL_TSX');

    const r = runNcl(['/usr/bin', '/bin']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LOCAL_TSX');
    expect(r.stderr).not.toMatch(/pnpm: not found/);
  });
});
