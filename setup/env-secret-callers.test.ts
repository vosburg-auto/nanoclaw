/**
 * Fork patch (vosburg-auto): guards the CALL SITES that must route `.env`
 * writes through `writeSecretEnvFile`.
 *
 * `env-utils.test.ts` proves the helper sets 0600. It does NOT prove anyone
 * uses it — `scripts/fork-guard-liveness.mjs` reverted both `setup/set-env.ts`
 * and `setup/timezone.ts` to upstream's bare `fs.writeFileSync` and that suite
 * stayed green. That is the exact shape of the regression the v2.1.54 sync
 * shipped: helper intact, call sites reverted, nothing red.
 *
 * `.env` holds bot tokens, so a umask-default write is a world-readable one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { upsertEnvVar } from './set-env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

describe('setup/set-env.ts', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-set-env-'));
    process.chdir(dir); // upsertEnvVar resolves .env against process.cwd()
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates .env owner-only', () => {
    upsertEnvVar('TELEGRAM_BOT_TOKEN', 'x');
    expect(modeOf(path.join(dir, '.env'))).toBe(0o600);
  });

  it('repairs a pre-existing world-readable .env on update', () => {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'EXISTING=1\n');
    fs.chmodSync(envFile, 0o644);

    upsertEnvVar('TELEGRAM_BOT_TOKEN', 'x');

    expect(modeOf(envFile)).toBe(0o600);
    expect(fs.readFileSync(envFile, 'utf8')).toContain('EXISTING=1');
  });

  it('keeps 0600 when updating a key that already exists', () => {
    upsertEnvVar('TELEGRAM_BOT_TOKEN', 'first');
    const res = upsertEnvVar('TELEGRAM_BOT_TOKEN', 'second');
    expect(res.existed).toBe(true);
    expect(modeOf(path.join(dir, '.env'))).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('TELEGRAM_BOT_TOKEN=second');
  });
});

describe('setup/timezone.ts', () => {
  // timezone.ts exports only `run(args)`, which is an interactive setup step
  // with no injectable path — there is no seam to assert a file mode through.
  // This is a SOURCE-LEVEL check, weaker than the behavioural cases above, and
  // recorded as such rather than dressed up. It still catches the failure that
  // actually happened: a sync taking upstream's copy of this file.
  const source = fs.readFileSync(path.join(HERE, 'timezone.ts'), 'utf8');

  it('routes .env writes through writeSecretEnvFile', () => {
    expect(source).toContain('writeSecretEnvFile');
    expect(source).toContain("from './env-utils.js'");
  });

  it('makes no bare fs.writeFileSync call to the env file', () => {
    const bare = source.match(/fs\.writeFileSync\(\s*envFile/g) ?? [];
    expect(bare, `bare fs.writeFileSync(envFile, …) found: ${bare.join(', ')}`).toHaveLength(0);
  });
});
