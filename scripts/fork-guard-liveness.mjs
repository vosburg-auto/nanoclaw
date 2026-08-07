#!/usr/bin/env node
/**
 * Prove that every fork patch's guard actually goes red when the patch is
 * reverted.
 *
 * WHY
 * ---
 * The v2.1.54 upstream sync reverted two fork hardenings and the suite stayed
 * green — not because no tests existed, but because the tests that existed
 * could not fail. One asserted a base64url character class against an id that
 * had been downgraded to base36 (a strict subset). Another was deleted along
 * with the feature, because it lived in a filename upstream also owns.
 *
 * The registry that replaced those was itself found to contain an inert check:
 * a row pointing at a database-migration test for a feature whose runtime
 * effect lives in a different package entirely.
 *
 * "Write a check that can fail" is easy to say and demonstrably hard to do by
 * care alone. This script decides it mechanically:
 *
 *   for each carried patch with a guard:
 *     1. run the guard on the current tree      -> must PASS  (else the guard is broken)
 *     2. replace the path with upstream's copy  (or delete it, if fork-owned)
 *     3. run the guard again                    -> must FAIL  (else the guard is inert)
 *     4. restore
 *
 * A guard that passes both times is worse than no guard: it reports safety it
 * does not provide.
 *
 * USAGE
 *   node scripts/fork-guard-liveness.mjs --list          # what would be checked
 *   node scripts/fork-guard-liveness.mjs                 # check everything
 *   node scripts/fork-guard-liveness.mjs --only <path>   # one patch
 *
 * SAFETY: mutates the working tree, so it refuses to run on a dirty tree and
 * restores from git on every exit path including SIGINT.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(REPO, 'docs', 'fork-patches.json');

const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

function runGuard(cmd) {
  const r = spawnSync(cmd, { cwd: REPO, shell: true, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Upstream's version of `p`, or null if upstream has no such path. */
function upstreamBlob(p) {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `upstream/main:${p}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Which patches this run would check: carried patches that name a guard,
 * optionally narrowed to one path. Pure — split out so the selection rules
 * (superseded excluded, guard-waived excluded, `--only` narrowing) are testable
 * without mutating a working tree.
 */
export function selectTargets(manifest, only = null) {
  const targets = manifest.patches.filter((p) => p.status === 'carried' && p.guard);
  return only ? targets.filter((p) => p.path === only) : targets;
}

/**
 * The verdict for one patch, from its guard's exit status before and after the
 * revert. This is the script's entire reason to exist, so it is worth pinning:
 *
 *   before fail            -> 'broken' (the guard doesn't work on a good tree)
 *   before pass, after pass -> 'inert' (the guard can't detect the revert)
 *   before pass, after fail -> 'live'  (the guard does its job)
 */
export function classify({ beforeOk, afterOk }) {
  if (!beforeOk) return 'broken';
  return afterOk ? 'inert' : 'live';
}

/** Argv → run options. Pure. */
export function parseArgs(argv) {
  const onlyIdx = argv.indexOf('--only');
  return { listOnly: argv.includes('--list'), only: onlyIdx === -1 ? null : argv[onlyIdx + 1] };
}

function main() {
  const args = process.argv.slice(2);
  const { listOnly, only } = parseArgs(args);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const targets = selectTargets(manifest, only);

  if (listOnly) {
    for (const t of targets) console.log(`${t.path}\n    ${t.guard}`);
    const waived = manifest.patches.filter((p) => p.status === 'carried' && !p.guard);
    console.log(`\n${targets.length} guarded, ${waived.length} waived:`);
    for (const w of waived) console.log(`    ${w.path} — ${w.guard_waiver || w.kind}`);
    process.exit(0);
  }

  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    console.error('fork-guard-liveness: refusing to run on a dirty tree (this script mutates files).\n');
    console.error(dirty);
    process.exit(2);
  }

  const touched = new Set();
  const restore = () => {
    for (const p of touched) {
      try {
        git(['checkout', '--', p]);
      } catch {
        /* file may have been fork-owned and deleted — checkout restores it */
      }
    }
    touched.clear();
  };
  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });

  const inert = [];
  const broken = [];
  let checked = 0;

  for (const t of targets) {
    const abs = path.join(REPO, t.path);
    process.stdout.write(`\n=== ${t.path}\n    guard: ${t.guard}\n`);

    const before = runGuard(t.guard);
    if (classify({ beforeOk: before.ok, afterOk: false }) === 'broken') {
      console.log(`    BROKEN — guard fails on the unmodified tree (exit ${before.status})`);
      broken.push({ ...t, detail: before.out.split('\n').slice(-12).join('\n') });
      continue;
    }
    console.log('    baseline: pass');

    const original = fs.readFileSync(abs);
    const upstream = upstreamBlob(t.path);
    touched.add(t.path);
    try {
      if (upstream === null) {
        // Fork-owned path: upstream has no copy, so "revert" means "remove".
        fs.rmSync(abs);
        console.log('    reverted: deleted (path does not exist upstream)');
      } else {
        fs.writeFileSync(abs, upstream);
        console.log("    reverted: replaced with upstream/main's copy");
      }

      const after = runGuard(t.guard);
      checked += 1;
      if (classify({ beforeOk: before.ok, afterOk: after.ok }) === 'inert') {
        console.log('    INERT — guard still passes with the patch reverted');
        inert.push(t);
      } else {
        console.log(`    live: guard fails as required (exit ${after.status})`);
      }
    } finally {
      fs.writeFileSync(abs, original);
      touched.delete(t.path);
    }
  }

  restore();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`checked ${checked} guarded patch(es)`);
  if (broken.length) {
    console.error(`\n${broken.length} BROKEN guard(s) — fail on the unmodified tree:`);
    for (const b of broken) console.error(`  - ${b.path}\n${b.detail}`);
  }
  if (inert.length) {
    console.error(`\n${inert.length} INERT guard(s) — pass even with the patch reverted:`);
    for (const i of inert) console.error(`  - ${i.path}: ${i.guard}`);
    console.error('\nAn inert guard is worse than none: it reports safety it does not provide.');
  }
  process.exit(broken.length || inert.length ? 1 : 0);
}

// Main-guard: importing this module (from its test) must not read the manifest,
// shell out to git, mutate the working tree, or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
