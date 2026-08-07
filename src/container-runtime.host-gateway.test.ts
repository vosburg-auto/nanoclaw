/**
 * Fork patch (vosburg-auto): guards `hostGatewayArgs` / NANOCLAW_HOST_GATEWAY_IP.
 *
 * Deliberately a SEPARATE file from `container-runtime.test.ts`: upstream owns
 * that filename, so a sync that takes upstream's copy wholesale silently drops
 * any fork case living inside it. That is exactly how the webhook loopback-bind
 * guard was lost in the v2.1.54 sync (its six assertions were in the
 * upstream-owned `webhook-server.test.ts`) while CI stayed green.
 *
 * Rule: fork tests go in fork-owned filenames. See docs/BRANCH-FORK-MAINTENANCE.md.
 */
import os from 'os';

import { describe, it, expect, afterEach } from 'vitest';

import { hostGatewayArgs } from './container-runtime.js';

describe('hostGatewayArgs', () => {
  const saved = process.env.NANOCLAW_HOST_GATEWAY_IP;
  afterEach(() => {
    if (saved === undefined) delete process.env.NANOCLAW_HOST_GATEWAY_IP;
    else process.env.NANOCLAW_HOST_GATEWAY_IP = saved;
  });

  it('points host.docker.internal at NANOCLAW_HOST_GATEWAY_IP when set', () => {
    // The ss-smith-vm case: nanoclaw runs on a different box than the services
    // containers reach via "the host" (OneCLI credential proxy, notify endpoints).
    process.env.NANOCLAW_HOST_GATEWAY_IP = '192.168.10.36';
    expect(hostGatewayArgs()).toEqual(['--add-host=host.docker.internal:192.168.10.36']);
  });

  it('ignores an empty override and falls through to the platform default', () => {
    // An empty env var must not produce `--add-host=host.docker.internal:` (a malformed
    // flag docker rejects) — it means "unset", so the platform default applies.
    process.env.NANOCLAW_HOST_GATEWAY_IP = '';
    expect(hostGatewayArgs()).not.toContain('--add-host=host.docker.internal:');
  });

  it('falls back to host-gateway on Linux when no override is set', () => {
    delete process.env.NANOCLAW_HOST_GATEWAY_IP;
    const args = hostGatewayArgs();
    if (os.platform() === 'linux') {
      expect(args).toEqual(['--add-host=host.docker.internal:host-gateway']);
    } else {
      expect(args).toEqual([]);
    }
  });
});
