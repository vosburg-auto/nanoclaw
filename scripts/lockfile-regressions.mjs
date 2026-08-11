#!/usr/bin/env node
/**
 * Fail when a ref resolves a dependency to a LOWER version than the base ref
 * does — i.e. when a sync silently gives back a security bump.
 *
 * WHY THIS EXISTS
 * ---------------
 * `fork-surface.mjs` answers "is this path fork-modified, and is it
 * dispositioned?". `pnpm-lock.yaml` is both, so it stays green — and it has no
 * opinion whatsoever about the VERSIONS inside a dispositioned file. That is
 * not a bug in it; it compares blobs to decide ownership, not contents to
 * decide whether a pin regressed.
 *
 * The gap is not hypothetical. PR #7 bumped postcss 8.5.10 -> 8.5.25 on main,
 * closing two HIGH advisories (arbitrary file read via attacker-controlled
 * sourceMappingURL). The v2.1.54 sync branch had taken upstream's lockfile
 * wholesale, and upstream still pinned 8.5.10 — so merging the sync would have
 * quietly reinstated the vulnerable version. It was caught by a human reading a
 * version number, which is exactly the detection method this repo has twice
 * proven does not scale (see the seven inert guards, and the eighth CI found).
 *
 * Every future sync takes upstream's lockfile wholesale, so every future sync
 * can revert every dependency fix merged since the last one. That is a standing
 * hazard, not a one-off.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It compares RESOLVED versions, not advisory status — it does not know which
 * downgrades are security-relevant, and deliberately does not ask GitHub. A
 * downgrade is reported whether or not a CVE is attached, because "this sync
 * moved a dependency backwards" is the thing a reviewer needs told either way.
 *
 * It compares the MAXIMUM resolved version per package. A lockfile can carry
 * several versions of one package; dropping a duplicate lower copy is normal
 * and is not a regression, whereas losing the highest copy is.
 *
 * Intentional downgrades go in docs/lockfile-waivers.json with a reason.
 *
 * USAGE
 *   node scripts/lockfile-regressions.mjs                    # HEAD vs origin/main
 *   node scripts/lockfile-regressions.mjs --base upstream/main
 *   node scripts/lockfile-regressions.mjs --base X --head Y
 *   node scripts/lockfile-regressions.mjs --json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = 'pnpm-lock.yaml';
const WAIVERS = path.join(REPO, 'docs', 'lockfile-waivers.json');

/**
 * Split a pnpm lock key into { name, version }.
 *
 * Keys look like `postcss@8.5.25`, `'@types/node@22.19.17'`, or
 * `vite@8.0.8(@types/node@22.19.17)(esbuild@0.27.7)` — the parenthesised peer
 * suffix is not part of the version. Scoped names start with `@`, so the split
 * is on the LAST `@` that follows at least one name character.
 */
export function parseKey(rawKey) {
  let key = rawKey.trim().replace(/:$/, '');
  if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
    key = key.slice(1, -1);
  }
  const peer = key.indexOf('(');
  if (peer !== -1) key = key.slice(0, peer);
  const at = key.lastIndexOf('@');
  if (at <= 0) return null; // no version, or a bare scope like `@types`
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (!name || !version || !/^\d/.test(version)) return null;
  return { name, version };
}

/**
 * Compare two semver-ish strings. Returns <0, 0, >0.
 *
 * Deliberately small: pnpm writes resolved, concrete versions, so the full
 * semver grammar is not in play. Numeric segments compare numerically, and a
 * prerelease sorts BELOW its release (1.0.0-rc.15 < 1.0.0) per semver.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const dash = v.indexOf('-');
    const core = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? null : v.slice(dash + 1);
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
    const d = (A.core[i] ?? 0) - (B.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1; // release > prerelease
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/**
 * name -> highest resolved version, over every package key in the lockfile.
 *
 * Scans keys at any indent rather than tracking the `packages:` / `snapshots:`
 * section: both sections list the same keys, taking the max is idempotent, and
 * a section-aware parser would go stale the next time pnpm changes its layout.
 */
export function maxVersions(lockText) {
  const out = new Map();
  for (const line of lockText.split('\n')) {
    if (!/^ {2,4}\S.*:\s*$/.test(line)) continue;
    const parsed = parseKey(line);
    if (!parsed) continue;
    const cur = out.get(parsed.name);
    if (cur === undefined || compareVersions(parsed.version, cur) > 0) out.set(parsed.name, parsed.version);
  }
  return out;
}

/**
 * Packages whose max version went DOWN from base to head. Pure — the whole
 * decision, so it is testable without git.
 */
export function findRegressions(baseVersions, headVersions, waived = new Set()) {
  const regressions = [];
  for (const [name, baseV] of baseVersions) {
    const headV = headVersions.get(name);
    if (headV === undefined) continue; // dependency dropped entirely, not a downgrade
    if (compareVersions(headV, baseV) < 0 && !waived.has(name)) {
      regressions.push({ name, base: baseV, head: headV });
    }
  }
  return regressions.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadWaivers(file = WAIVERS) {
  if (!fs.existsSync(file)) return new Map();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = new Map();
  for (const w of raw.waivers ?? []) {
    if (!w.package || !w.reason) throw new Error(`lockfile waiver needs both \`package\` and \`reason\`: ${JSON.stringify(w)}`);
    m.set(w.package, w.reason);
  }
  return m;
}

function readLockAt(ref) {
  return execFileSync('git', ['-C', REPO, 'show', `${ref}:${LOCKFILE}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Argv -> options. Pure. */
export function parseArgs(argv) {
  const val = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i === -1 ? dflt : argv[i + 1];
  };
  return { base: val('--base', 'origin/main'), head: val('--head', 'HEAD'), json: argv.includes('--json') };
}

function main(argv) {
  const { base, head, json } = parseArgs(argv);

  let baseText;
  try {
    baseText = readLockAt(base);
  } catch {
    console.error(`lockfile-regressions: cannot read ${LOCKFILE} at ${base} — fetch it first (\`git fetch origin\`).`);
    process.exit(2);
  }
  const headText = head === 'HEAD' && fs.existsSync(path.join(REPO, LOCKFILE))
    ? fs.readFileSync(path.join(REPO, LOCKFILE), 'utf8')
    : readLockAt(head);

  const waivers = loadWaivers();
  const regressions = findRegressions(maxVersions(baseText), maxVersions(headText), new Set(waivers.keys()));

  if (json) {
    console.log(JSON.stringify({ base, head, regressions }, null, 2));
    process.exit(regressions.length ? 1 : 0);
  }

  if (!regressions.length) {
    console.log(`lockfile-regressions: OK — no dependency resolves lower at ${head} than at ${base}.`);
    if (waivers.size) for (const [p, r] of waivers) console.log(`  waived: ${p} — ${r}`);
    process.exit(0);
  }

  console.error(`lockfile-regressions: ${regressions.length} dependency downgrade(s) from ${base} to ${head}\n`);
  for (const r of regressions) console.error(`  - ${r.name}: ${r.base} -> ${r.head}`);
  console.error(
    `\nA sync that takes upstream's ${LOCKFILE} wholesale gives back every bump merged since the last one, ` +
      `and no other check sees it. Merge ${base} into this branch to carry them across, or waive the downgrade ` +
      `with a reason in docs/lockfile-waivers.json.`,
  );
  process.exit(1);
}

// Main-guard: importing this module (from its test) must not shell out to git
// or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
