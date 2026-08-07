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

Every patch this fork carries on top of upstream, with the check that proves it survived. **A patch not in this table will be lost at some sync** — that is not a prediction, it is what happened to the webhook loopback bind and the CSPRNG approval ids during the v2.1.54 sync.

### Deriving the surface mechanically — do this FIRST, every sync

Do not enumerate fork patches by memory or by looking for fork-owned _files_. "Files in HEAD that never existed upstream" is structurally blind to patches applied to files that also exist upstream — the class that contains every hardening lost in v2.1.54. Instead, ask which **blobs** in the fork's tree appear nowhere in upstream's history:

```bash
git fetch upstream --prune
git rev-list --objects --remotes=upstream | awk '{print $1}' | sort -u > /tmp/upstream_blobs
git ls-tree -r origin/main --format='%(objectname) %(path)' \
  | awk 'NR==FNR{u[$1];next} !($1 in u){print $2}' /tmp/upstream_blobs - \
  | sort
```

Note `--remotes=upstream` with **no** `--all`: adding `--all` pulls in the fork's own refs and the query silently returns nothing.

Every path it prints is fork-modified content. Reconcile that list against the table below item by item, and for anything you intend to drop, state "superseded upstream" with the reason. After the sync, re-run it against the sync branch: a path that was fork-modified before and now matches an upstream blob exactly has been **reverted**, not merged.

### The registry

| Patch                                  | Intent                                                                                                    | Resolution                                                                                                                                      | Post-sync check                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bin/ncl` runner resolution            | CLI must work on hosts with deps installed but no pnpm on PATH (ss-smith-vm)                              | **Keep the fork's block.** Upstream's launcher ends at `exec pnpm exec tsx …`                                                                   | `pnpm exec vitest run src/cli/ncl-launcher.test.ts`                  |
| `src/webhook-server.ts` loopback bind  | Don't expose the webhook port to the LAN; `WEBHOOK_BIND` is the opt-in                                    | Re-apply `DEFAULT_BIND` + `resolveListenConfig` on top of upstream's file                                                                       | `pnpm exec vitest run src/webhook-server.bind.test.ts`               |
| `src/modules/approvals/approval-id.ts` | Approval ids are capabilities; 128-bit CSPRNG, not `Math.random()`                                        | Fork-owned file; both call sites import it. Keep the `ap`/`oa` prefixes — longer ones bust Telegram's 64-byte `callback_data` budget            | `pnpm exec vitest run src/modules/approvals/approval-id.test.ts`     |
| `.env` 0600 hardening                  | `.env` holds bot tokens; upstream rewrites these steps to bare `writeFileSync`                            | Rewire `setup/set-env.ts` + `setup/timezone.ts` through `writeSecretEnvFile`                                                                    | `pnpm exec vitest run setup/env-utils.test.ts`                       |
| `container/Dockerfile` agent tooling   | Baked `ffmpeg`, `gh`, `openssh-client`, `jq` for report-TTS, GitHub CLI, the Pi fleet, and JSON in skills | Re-add the fork's `RUN apt-get …` layer before `# ---- Entrypoint`                                                                              | `grep -q 'openssh-client' container/Dockerfile`                      |
| `NANOCLAW_HOST_GATEWAY_IP`             | nanoclaw runs on a different box than the services containers reach as "the host"                         | Keep `hostGatewayArgs()` in `src/container-runtime.ts`                                                                                          | `pnpm exec vitest run src/container-runtime.host-gateway.test.ts`    |
| `TELEGRAM_ALLOWED_UPDATES`             | `callback_query` carries OneCLI approval clicks; `message_reaction` carries 👍/👎                         | Re-apply the `longPolling.allowedUpdates` hunk in `src/channels/telegram.ts`                                                                    | `pnpm exec vitest run src/channels/telegram-allowed-updates.test.ts` |
| `fork-auto-compact-window` migration   | Per-group auto-compact threshold                                                                          | Keep `name: 'auto-compact-window'` — it is the `schema_version` key. The `fork-` filename + version 900 keep it out of upstream's numeric range | `pnpm exec vitest run src/db/db-v2.test.ts`                          |
| `@chat-adapter/telegram` dependency    | Upstream keeps telegram on its `channels` branch, not `main`                                              | Re-add at the exact pin upstream's `channels` branch requires                                                                                   | `pnpm exec vitest run src/channels/telegram-registration.test.ts`    |
| ShellCheck annotations                 | Four upstream shell files fail `shellcheck -S error`; upstream runs no ShellCheck                         | Comment-only re-apply                                                                                                                           | `shellcheck -S error $(git ls-files '*.sh')`                         |
| `.gitignore` entries                   | Fork-local ignores                                                                                        | Combine, don't replace                                                                                                                          | —                                                                    |

### Two rules the v2.1.54 sync bought the hard way

1. **Fork tests go in fork-owned filenames.** `src/webhook-server.test.ts` held the six assertions guarding the loopback bind. Upstream owns that filename; taking upstream's copy deleted the feature and its detector in one commit, and CI stayed green. Hence `webhook-server.bind.test.ts`, `container-runtime.host-gateway.test.ts`, `telegram-allowed-updates.test.ts`, `approval-id.test.ts`.

2. **A guard that cannot fail is not a guard.** The approval-id test asserted the id matched `[A-Za-z0-9_-]+`. Base36 is a subset of base64url, so it passed against the reverted `Math.random()` implementation. Assert the property that actually distinguishes the two — here, decoded byte length.

## When to merge forward

After any main change that touches shared files (`package.json`, `src/index.ts`, `CLAUDE.md`, etc.). Small frequent merges = trivial conflicts. Large infrequent merges = painful. A registry branch that drifts far behind main also means every `/add-*` install copies in code written against an old core.

## Adding a new channel or provider

Skills replaced fork setup. The short version ([CONTRIBUTING.md](../CONTRIBUTING.md) has the full flow):

1. Build the adapter or provider following [skill-guidelines.md](skill-guidelines.md): a self-registering module, one appended barrel import, and a registration test that imports the real barrel.
2. Write the `/add-<name>` skill in `.claude/skills/` on `main` — a SKILL.md with the fetch-and-copy steps and a REMOVE.md that reverses them.
3. Open a PR from a branch off `main`; maintainers land the code portion on the registry branch.

## Dependencies

Registry branches add their own deps on top of upstream's. Skill `nc:dep` directives pin exact versions at install time (the supply-chain policy rejects ranges and `latest`). When upstream adds or removes a dependency, verify the registry branches still build after the next forward merge — transitive dependency changes can break adapter code.
