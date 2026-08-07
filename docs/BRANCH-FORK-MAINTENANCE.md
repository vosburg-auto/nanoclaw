# Branch and fork maintenance

How the long-lived branches on `nanocoai/nanoclaw` relate to `main` and how to keep them in sync. This is the maintainer view: [skills-model.md](skills-model.md) explains the customization model itself, and [CONTRIBUTING.md](../CONTRIBUTING.md) covers contributing a channel or provider.

## Structure

**`main`** — core engine plus skill definitions (`.claude/skills/`). It carries the shared channel machinery every install needs (`src/channels/`: adapter interface, channel registry, Chat SDK bridge, CLI channel, ask-question flow, channel defaults) and the default Claude provider — but no optional channel adapters and no alternative providers.

**Registry branches** (`channels`, `providers`) — long-lived branches carrying the code that channel and provider skills install. `channels` holds every channel adapter with its tests (`src/channels/telegram.ts`, `src/channels/telegram-registration.test.ts`, …); `providers` holds the alternative agent providers (OpenCode, Codex). The `/add-*` skills on `main` fetch files from these branches (`git show origin/channels:<path> > <path>`) — an additive copy into the user's clone, never a merge. (Not every provider needs branch code: `/add-ollama-provider` is configuration-only and redirects the built-in Claude path.)

**Legacy mechanisms** — the channel fork repos (`nanoclaw-whatsapp`, `nanoclaw-telegram`, …) and the `skill/*` branches (`skill/compact`, `skill/apple-container`, …) are the pre-skills delivery model: applied code that users merged into their clones. They are frozen (no forward merges since spring 2026) and superseded by the registry branches and `/add-*` skills. Don't build on them and don't forward-merge them.

## How users add capabilities

```
user clones upstream main
  ├── runs /add-whatsapp   → skill copies the adapter in from the channels branch
  ├── runs /add-opencode   → skill copies the provider in from the providers branch
  └── runs /add-<tool>     → skill copies files in from its own folder
```

Registry-backed installs are additive fetch-and-copies; other skills ship their files in their own folder or are instruction-only. Either way a user's clone never merges a registry branch, and registry branches are never merged back into `main`. [skills-model.md](skills-model.md) explains why.

## Merge directions

```
upstream main ──→ channels     (forward merge to keep adapters building against current core)
upstream main ──→ providers    (forward merge, same reason)
```

Fixes to existing adapters and providers land as PRs based directly on the registry branch. New channels and providers are contributed from a branch off `main` (see [Adding a new channel or provider](#adding-a-new-channel-or-provider)); maintainers land the code portion on the registry branch. Nothing merges back into `main`.

## Forward merge procedure

```bash
# In your local nanoclaw checkout
git checkout main && git pull

git checkout -B channels origin/channels
git merge main
# Resolve conflicts (see below)
git push origin channels
git checkout main && git branch -D channels
```

Same procedure for `providers`.

This procedure assumes the branch is reasonably current. A registry branch left unmerged for months will conflict far beyond the table below — treat a large catch-up as its own reviewed effort, build and test both branches afterward, and update the table from that merge's actual receipts.

## Conflict resolution

Files with known mechanical resolutions:

| File                    | Resolution                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`          | Take main's version + keep branch-specific deps                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm-lock.yaml`        | `git checkout main -- pnpm-lock.yaml && pnpm install`                                                                                                                                                                                                                                                                                                                                                         |
| `.env.example`          | Combine: main's entries + branch-specific entries                                                                                                                                                                                                                                                                                                                                                             |
| `repo-tokens/badge.svg` | Take main's version (auto-generated)                                                                                                                                                                                                                                                                                                                                                                          |
| `bin/ncl`               | **Keep the fork's runner-resolution block.** Upstream's launcher ends at `exec pnpm exec tsx …`; the fork resolves `node_modules/.bin/tsx` first, then falls back to pnpm, then fails loudly — without it the CLI is unusable on hosts that have deps installed but no pnpm on PATH (ss-smith-vm). Post-sync check: `pnpm exec vitest run src/cli/ncl-launcher.test.ts` (4 cases, pins the resolution order). |

Source code changes (e.g. `src/types.ts`, `src/index.ts`) usually auto-merge cleanly, but can conflict if both sides modify the same lines. **Always build and test after every forward merge** — auto-merged code can be silently wrong (e.g. referencing a renamed function or using a removed parameter) even when git reports no conflicts.

## Fork carry-forward registry (vosburg-auto)

Every patch this fork carries on top of upstream, and the command that goes red if it is reverted.

**There is no table here.** The first version of this section WAS a table, and it was stale on arrival — it omitted a patch added by the very commit that created it, and one of its checks could not fail. A hand-maintained list duplicating a mechanically derivable one is a second source of truth, and the second one is the one that rots. So:

|                                        |                                                                    |
| -------------------------------------- | ------------------------------------------------------------------ |
| **Which paths are fork-modified**      | derived by `scripts/fork-surface.mjs` — the query is the authority |
| **Intent, disposition, guard command** | `docs/fork-patches.json` — only what the query cannot know         |
| **Do the two agree?**                  | `node scripts/fork-surface.mjs check` — fails in BOTH directions   |
| **Does each guard actually work?**     | `node scripts/fork-guard-liveness.mjs`                             |

Both checks run in CI on every PR.

### The derivation

A path is fork-modified iff its blob appears in **no** commit reachable from any `upstream/*` ref. Content-addressing makes this exact, and it catches fork edits inside files that also exist upstream — the class that "files that never existed upstream" is blind to, and the class that contained every hardening the v2.1.54 sync silently dropped.

```bash
git fetch upstream --prune
node scripts/fork-surface.mjs list      # the fork surface at HEAD
node scripts/fork-surface.mjs check     # ...and whether the manifest agrees
```

`fork-surface.mjs check` fails if the query finds a path the manifest does not disposition, **and** if the manifest claims a patch whose content now matches upstream. The second direction is what catches a silent revert: a carried patch whose blob has gone back to upstream's is either lost or upstreamed, and you must say which.

### At every sync

1. `node scripts/fork-surface.mjs check --ref origin/main` — snapshot the surface before you start.
2. Take upstream's tree and re-apply.
3. `node scripts/fork-surface.mjs check` — every path it complains about is either a patch you dropped or one you need to disposition. Neither is optional.
4. `node scripts/fork-guard-liveness.mjs` — proves the guards still bite.
5. Record the upstream anchor (below) so the next sync has a merge base.

### Recording the upstream anchor

Each sync so far has taken upstream's tree wholesale without recording ancestry, so `git merge-base` still resolves to a v2.0.64-era commit and every sync reproduces the same phantom-conflict storm. After the sync branch is final, append an ancestry-only commit:

```bash
git merge -s ours upstream/main -m "chore: record upstream v<version> as an ancestor (tree unchanged)"
```

`-s ours` keeps our tree byte-for-byte and records upstream as a second parent. It is honest here **only because** the sync genuinely took upstream's tree — verify with `git diff --stat upstream/main HEAD` showing additions but no deletions of upstream content before running it. It is an append, so the `no-force-push-any-branch` ruleset does not block it. **The PR must then land via "Create a merge commit"** — a squash merge discards the second parent and the next sync inherits the same stale base.

### Two rules the v2.1.54 sync bought the hard way

1. **Fork tests go in fork-owned filenames.** `src/webhook-server.test.ts` held the six assertions guarding the loopback bind. Upstream owns that filename; taking upstream's copy deleted the feature and its detector in one commit, and CI stayed green.

2. **A guard that cannot fail is not a guard.** The approval-id test asserted the id matched `[A-Za-z0-9_-]+`. Base36 is a subset of base64url, so it passed against the reverted `Math.random()` implementation. `fork-guard-liveness.mjs` exists so this is decided mechanically rather than by care: it reverts each patch and requires the guard to go red.

## When to merge forward

After any main change that touches shared files (`package.json`, `src/index.ts`, `CLAUDE.md`, etc.). Small frequent merges = trivial conflicts. Large infrequent merges = painful. A registry branch that drifts far behind main also means every `/add-*` install copies in code written against an old core.

## Adding a new channel or provider

Skills replaced fork setup. The short version ([CONTRIBUTING.md](../CONTRIBUTING.md) has the full flow):

1. Build the adapter or provider following [skill-guidelines.md](skill-guidelines.md): a self-registering module, one appended barrel import, and a registration test that imports the real barrel.
2. Write the `/add-<name>` skill in `.claude/skills/` on `main` — a SKILL.md with the fetch-and-copy steps and a REMOVE.md that reverses them.
3. Open a PR from a branch off `main`; maintainers land the code portion on the registry branch.

## Dependencies

Registry branches add their own deps on top of upstream's. Skill `nc:dep` directives pin exact versions at install time (the supply-chain policy rejects ranges and `latest`). When upstream adds or removes a dependency, verify the registry branches still build after the next forward merge — transitive dependency changes can break adapter code.
