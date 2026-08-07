#!/usr/bin/env node
/**
 * Derive this fork's patch surface mechanically, and hold `docs/fork-patches.json`
 * accountable to it.
 *
 * WHY THIS IS A SCRIPT AND NOT A TABLE IN A DOC
 * --------------------------------------------
 * The v2.1.54 upstream sync silently reverted two fork hardenings. The first
 * attempt to prevent a recurrence was a hand-maintained table in
 * docs/BRANCH-FORK-MAINTENANCE.md. It was stale on arrival: it omitted a patch
 * added by the very commit that created it. A hand-maintained list that
 * duplicates a mechanically derivable one is a second source of truth, and the
 * second one is always the one that rots.
 *
 * So: the QUERY is the authority. The manifest carries only what the query
 * cannot know — intent, disposition, and which command guards the patch — and
 * `--check` fails when the two disagree in either direction.
 *
 * THE DERIVATION
 * --------------
 * A path is fork-modified iff its blob at the target ref appears in NO commit
 * reachable from any `upstream/*` remote-tracking ref. Content-addressing makes
 * this exact: identical content is an identical blob, so this catches fork edits
 * inside files that also exist upstream — the class that "files that never
 * existed upstream" is blind to, and the class that contained every hardening
 * the v2.1.54 sync dropped.
 *
 * Note `--remotes=upstream` with NO `--all`: adding `--all` pulls in the fork's
 * own refs and the query silently returns the empty set.
 *
 * USAGE
 *   node scripts/fork-surface.mjs list            # fork-modified paths at HEAD
 *   node scripts/fork-surface.mjs check           # CI gate: manifest <-> query
 *   node scripts/fork-surface.mjs report          # markdown table for docs
 *   node scripts/fork-surface.mjs check --ref X   # against another ref
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(REPO, 'docs', 'fork-patches.json');

const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

/** Object ids reachable from every upstream remote-tracking ref. */
function upstreamObjects() {
  const out = git(['rev-list', '--objects', '--remotes=upstream']);
  const set = new Set();
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    const oid = sp === -1 ? line : line.slice(0, sp);
    if (oid) set.add(oid);
  }
  if (set.size === 0) {
    throw new Error(
      'no objects reachable from refs/remotes/upstream/* — run `git fetch upstream` first ' +
        '(an empty upstream set would make every path look fork-modified)',
    );
  }
  return set;
}

/** Paths at `ref` whose CONTENT appears nowhere in upstream's history. */
export function forkModifiedPaths(ref = 'HEAD') {
  const upstream = upstreamObjects();
  const tree = git(['ls-tree', '-r', ref, '--format=%(objectname) %(path)']);
  const paths = [];
  for (const line of tree.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const oid = line.slice(0, sp);
    const p = line.slice(sp + 1);
    if (!upstream.has(oid)) paths.push(p);
  }
  return paths.sort();
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) throw new Error(`missing manifest: ${MANIFEST}`);
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(m.patches)) throw new Error('manifest.patches must be an array');
  return m;
}

const KINDS = new Set(['source', 'test', 'doc', 'config', 'generated']);

function check(ref) {
  const derived = new Set(forkModifiedPaths(ref));
  const manifest = loadManifest();
  const byPath = new Map();
  const problems = [];

  for (const p of manifest.patches) {
    if (!p.path) problems.push('manifest entry with no `path`');
    if (byPath.has(p.path)) problems.push(`duplicate manifest entry: ${p.path}`);
    byPath.set(p.path, p);
    if (!KINDS.has(p.kind)) problems.push(`${p.path}: kind must be one of ${[...KINDS].join('|')}, got ${p.kind}`);
    if (!p.intent || p.intent.length < 10) problems.push(`${p.path}: needs a real \`intent\``);
    // A carried SOURCE patch must name the command that goes red without it, or
    // carry an explicit waiver. Silence is what let the two v2.1.54 reverts land.
    if (p.status === 'carried' && p.kind === 'source' && !p.guard && !p.guard_waiver) {
      problems.push(`${p.path}: carried source patch with no \`guard\` and no \`guard_waiver\``);
    }
  }

  // Direction 1: the query found something the manifest does not know about.
  for (const p of derived) {
    if (!byPath.has(p)) problems.push(`UNDISPOSITIONED: ${p} is fork-modified at ${ref} but absent from the manifest`);
  }

  // Direction 2: the manifest claims a patch the tree no longer carries. Benign
  // for `superseded` (that IS the disposition); a live claim for anything else.
  for (const p of manifest.patches) {
    if (derived.has(p.path)) continue;
    if (p.status === 'superseded') continue;
    problems.push(
      `STALE: manifest lists ${p.path} as ${p.status}, but its content at ${ref} matches upstream ` +
        `(the patch is gone, or it was upstreamed — set status to "superseded" with a reason)`,
    );
  }

  if (problems.length) {
    console.error(`fork-surface: ${problems.length} problem(s) at ${ref}\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nThe query is the authority. Add a manifest entry for anything it prints, ' +
        'or record why the path no longer needs one.',
    );
    process.exit(1);
  }

  const carried = manifest.patches.filter((p) => p.status === 'carried');
  console.log(`fork-surface: OK — ${derived.size} fork-modified path(s) at ${ref}, all dispositioned.`);
  console.log(`  carried: ${carried.length}  superseded: ${manifest.patches.length - carried.length}`);
}

function report(ref) {
  const derived = new Set(forkModifiedPaths(ref));
  const manifest = loadManifest();
  const rows = manifest.patches
    .filter((p) => p.status === 'carried')
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((p) => {
      const present = derived.has(p.path) ? '' : ' **(MISSING)**';
      const guard = p.guard ? `\`${p.guard}\`` : `_waived: ${p.guard_waiver}_`;
      return `| \`${p.path}\`${present} | ${p.kind} | ${p.intent} | ${guard} |`;
    });
  console.log(`<!-- generated by scripts/fork-surface.mjs report — do not edit by hand -->`);
  console.log(`<!-- ${derived.size} fork-modified paths at ${ref} -->\n`);
  console.log('| Path | Kind | Intent | Guard |');
  console.log('| --- | --- | --- | --- |');
  console.log(rows.join('\n'));
}

const args = process.argv.slice(2);
const cmd = args[0] || 'list';
const refIdx = args.indexOf('--ref');
const ref = refIdx === -1 ? 'HEAD' : args[refIdx + 1];

if (cmd === 'list') console.log(forkModifiedPaths(ref).join('\n'));
else if (cmd === 'check') check(ref);
else if (cmd === 'report') report(ref);
else {
  console.error(`unknown command: ${cmd} (want: list | check | report)`);
  process.exit(2);
}
