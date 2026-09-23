import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const SETUP = 'src/test/tmp-root.ts';

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r !== '' && !r.startsWith('..') && !r.startsWith(sep);
}

describe('test tmp hygiene', () => {
  it('os.tmpdir() and spawned mktemp land inside the private per-file root', () => {
    const root = process.env.NC_TEST_TMP_ROOT;
    expect(root, 'setup file did not run').toBeTruthy();
    expect(tmpdir()).toBe(root);
    const made = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
    expect(inside(made, root!)).toBe(true);
    const parent = process.env.NC_TEST_TMP_PARENT!;
    expect(inside(root!, parent)).toBe(true);
  });

  it('vitest.config.ts registers the setup file', async () => {
    // Dynamic import: vitest.config.ts sits outside tsconfig rootDir (src/).
    const config = (await import(pathToFileURL(join(process.cwd(), 'vitest.config.ts')).href)).default as {
      test?: { setupFiles?: string | string[] };
    };
    const raw = config.test?.setupFiles;
    const files = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    expect(files.map((f) => f.replace(/^\.\//, ''))).toContain(SETUP);
    // the registered path must be the module that exists on disk
    expect(readFileSync(join(process.cwd(), SETUP), 'utf8')).toContain('NC_TEST_TMP_ROOT');
  });
});
