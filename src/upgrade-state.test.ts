import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-upgrade-state' };
});

const TEST_DIR = '/tmp/nanoclaw-test-upgrade-state';

import {
  TRIPWIRE_EXIT_DELAY_MS,
  enforceUpgradeTripwire,
  getCodeVersion,
  isUpgradeCurrent,
  markerPath,
  readUpgradeState,
  writeUpgradeState,
} from './upgrade-state.js';

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('upgrade-state', () => {
  it('getCodeVersion reads the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(getCodeVersion()).toBe(pkg.version);
  });

  it('readUpgradeState returns null when the marker is absent', () => {
    expect(readUpgradeState()).toBeNull();
  });

  it('write then read round-trips, with version/via/updatedAt', () => {
    const written = writeUpgradeState({ version: '9.9.9', via: 'test' });
    expect(written).toMatchObject({ version: '9.9.9', via: 'test' });
    expect(written.updatedAt).toBeTruthy();
    expect(readUpgradeState()).toEqual(written);
  });

  it('write defaults the version to the code version', () => {
    expect(writeUpgradeState({ via: 'test' }).version).toBe(getCodeVersion());
  });

  it('isUpgradeCurrent: false when absent, false on mismatch, true on match', () => {
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    expect(isUpgradeCurrent()).toBe(true);
  });

  it('treats a corrupt marker as absent (fails closed, never throws)', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'upgrade-state.json'), '{ this is not json');
    expect(() => readUpgradeState()).not.toThrow();
    expect(readUpgradeState()).toBeNull();
    expect(isUpgradeCurrent()).toBe(false);
  });

  it('markerPath is upgrade-state.json under the data dir', () => {
    expect(markerPath()).toBe(path.join(TEST_DIR, 'upgrade-state.json'));
  });

  it('enforceUpgradeTripwire exits when not current and passes when current', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // delayMs: 0 throughout — the delay itself is covered separately below.

    // No marker → trips.
    await expect(enforceUpgradeTripwire(0)).rejects.toThrow('exit:1');

    // Stale marker → trips.
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    await expect(enforceUpgradeTripwire(0)).rejects.toThrow('exit:1');

    // Matching marker → passes.
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    await expect(enforceUpgradeTripwire(0)).resolves.toBeUndefined();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  // The crash-loop throttle. The tripwire runs before enforceStartupBackoff(),
  // so the circuit breaker cannot throttle a persistently-tripped install; this
  // delay is the only thing standing between a stuck marker and a ~12x/minute
  // respawn loop under Restart=always. Assert it is actually waited on — a
  // regression here is silent (the process still exits 1, just instantly).
  describe('enforceUpgradeTripwire — exit delay', () => {
    it('waits TRIPWIRE_EXIT_DELAY_MS before exiting when tripped', async () => {
      vi.useFakeTimers();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const settled = vi.fn();
      const p = enforceUpgradeTripwire().then(settled, settled);

      // One tick short of the delay: still waiting, no exit yet.
      await vi.advanceTimersByTimeAsync(TRIPWIRE_EXIT_DELAY_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toHaveBeenCalled();

      vi.useRealTimers();
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('does not delay on the happy path', async () => {
      writeUpgradeState({ version: getCodeVersion(), via: 'test' });
      vi.useFakeTimers();
      const settled = vi.fn();
      // No timer advance at all — a current install must not touch the timer.
      await enforceUpgradeTripwire().then(settled);
      expect(settled).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('the delay is long enough to break a systemd RestartSec=5 loop', () => {
      // Boundary check on the constant, not the code: the whole point is that
      // restarts land further apart than the default RestartSec. If someone
      // tunes this below ~5s the throttle stops throttling anything.
      expect(TRIPWIRE_EXIT_DELAY_MS).toBeGreaterThan(5_000);
      // ...and short enough that a human fixing the marker isn't left waiting.
      expect(TRIPWIRE_EXIT_DELAY_MS).toBeLessThanOrEqual(120_000);
    });
  });
});
