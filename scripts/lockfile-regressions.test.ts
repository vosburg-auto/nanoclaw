/**
 * Tests for scripts/lockfile-regressions.mjs.
 *
 * The script's whole value is catching a downgrade nothing else sees, so the
 * cases that matter are the ones that distinguish a real regression from the
 * three things that LOOK like one: a dropped dependency, a dropped duplicate
 * lower copy, and a prerelease.
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM script, no type declarations
import { compareVersions, findRegressions, maxVersions, parseKey } from './lockfile-regressions.mjs';

describe('parseKey', () => {
  it('splits a plain name@version', () => {
    expect(parseKey('  postcss@8.5.25:')).toEqual({ name: 'postcss', version: '8.5.25' });
  });

  it('keeps the scope on a scoped package', () => {
    expect(parseKey("  '@types/node@22.19.17':")).toEqual({ name: '@types/node', version: '22.19.17' });
  });

  it('drops the peer suffix, which is not part of the version', () => {
    // Regression guard: a naive lastIndexOf('@') on this key returns
    // "22.19.17)(esbuild" as the version and the package name comes out wrong.
    expect(parseKey('  vite@8.0.8(@types/node@22.19.17)(esbuild@0.27.7):')).toEqual({
      name: 'vite',
      version: '8.0.8',
    });
  });

  it('rejects keys that are not name@version', () => {
    expect(parseKey('  packages:')).toBeNull();
    expect(parseKey('  dependencies:')).toBeNull();
    expect(parseKey("  '@types':")).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    // 8.5.10 vs 8.5.9 is the case a string compare gets backwards, and it is
    // the shape of the real postcss finding.
    expect(compareVersions('8.5.10', '8.5.9')).toBeGreaterThan(0);
    expect(compareVersions('8.5.9', '8.5.10')).toBeLessThan(0);
  });

  it('treats a prerelease as below its release', () => {
    expect(compareVersions('1.0.0-rc.15', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.15')).toBeGreaterThan(0);
  });

  it('is zero for equal versions', () => {
    expect(compareVersions('8.5.25', '8.5.25')).toBe(0);
  });

  it('pads missing segments', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.3', '1.2.9')).toBeGreaterThan(0);
  });
});

describe('maxVersions', () => {
  it('takes the highest when a lockfile carries several copies', () => {
    const lock = ['packages:', '  picomatch@4.0.4:', '  picomatch@4.0.5:', 'snapshots:', '  picomatch@4.0.4: {}'].join(
      '\n',
    );
    expect(maxVersions(lock).get('picomatch')).toBe('4.0.5');
  });

  it('is not fooled by the numeric ordering of duplicate copies', () => {
    const lock = ['packages:', '  postcss@8.5.9:', '  postcss@8.5.10:'].join('\n');
    expect(maxVersions(lock).get('postcss')).toBe('8.5.10');
  });
});

describe('findRegressions', () => {
  const base = new Map([['postcss', '8.5.25']]);

  it('reports a downgrade', () => {
    expect(findRegressions(base, new Map([['postcss', '8.5.10']]))).toEqual([
      { name: 'postcss', base: '8.5.25', head: '8.5.10' },
    ]);
  });

  it('is silent when the version holds or rises', () => {
    expect(findRegressions(base, new Map([['postcss', '8.5.25']]))).toEqual([]);
    expect(findRegressions(base, new Map([['postcss', '8.6.0']]))).toEqual([]);
  });

  it('does not report a dependency that was removed outright', () => {
    // Dropping a dep is a different decision with different review questions;
    // reporting it here would make the signal noisy and get the check ignored.
    expect(findRegressions(base, new Map())).toEqual([]);
  });

  it('honours a waiver', () => {
    expect(findRegressions(base, new Map([['postcss', '8.5.10']]), new Set(['postcss']))).toEqual([]);
  });

  it('waives only the named package', () => {
    const twoDown = new Map([
      ['postcss', '8.5.10'],
      ['nanoid', '3.3.11'],
    ]);
    const b = new Map([
      ['postcss', '8.5.25'],
      ['nanoid', '3.3.16'],
    ]);
    expect(findRegressions(b, twoDown, new Set(['postcss'])).map((r: { name: string }) => r.name)).toEqual(['nanoid']);
  });
});
