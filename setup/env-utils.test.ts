/**
 * Fork patch (vosburg-auto): guards the 0600 mode on `.env`.
 *
 * The v2.1.54 sync reverted `set-env.ts` and `timezone.ts` to bare
 * `fs.writeFileSync`, leaving bot tokens at umask default, and nothing went red
 * — no test anywhere asserted a file mode. That is the recurrence this file
 * exists to stop, not a hypothetical one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { writeSecretEnvFile } from './env-utils.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-utils-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

describe('writeSecretEnvFile', () => {
  it('creates the file owner-only', () => {
    const p = path.join(dir, '.env');
    writeSecretEnvFile(p, 'TELEGRAM_BOT_TOKEN=secret\n');
    expect(modeOf(p)).toBe(0o600);
    expect(fs.readFileSync(p, 'utf8')).toBe('TELEGRAM_BOT_TOKEN=secret\n');
  });

  it('repairs a legacy world-readable file in place', () => {
    // The case the docstring calls out: `mode:` on writeFileSync is ignored for
    // an EXISTING file, so without the explicit chmod a pre-existing 0644 .env
    // stays world-readable through every rewrite.
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'OLD=1\n');
    fs.chmodSync(p, 0o644);
    expect(modeOf(p)).toBe(0o644);

    writeSecretEnvFile(p, 'TELEGRAM_BOT_TOKEN=secret\n');
    expect(modeOf(p)).toBe(0o600);
  });

  it('leaves no window at a wider mode when the umask is permissive', () => {
    const saved = process.umask(0o000);
    try {
      const p = path.join(dir, '.env');
      writeSecretEnvFile(p, 'A=1\n');
      expect(modeOf(p)).toBe(0o600);
    } finally {
      process.umask(saved);
    }
  });
});
