# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

### Fork (vosburg-auto)

- **Synced the fork from v2.1.54 to upstream v2.3.0+ (`upstream/main` @ 09441884) by a real `git merge`, so upstream is now an ancestor.** 19 conflicts, each resolved as upstream's structure plus the fork's intent:
  - **Async central DB ([BREAKING] upstream 2cd7b537).** Fork code ported to `await`: offline `ncl` (`OfflineTransport.open/close`, `Transport.close` may now return a Promise and `client.ts` awaits it), `scripts/offline-migrate.ts` (`main`/`appliedNames` async, `initDb(..., { role: 'migration' })`), the fork's `telegram.ts` pairing interceptor (five DB writes were silently un-awaited — tsc only caught the one whose result was read), and the fork tests. `eslint` (`no-floating-promises`) is clean over `src/`.
  - **Fork migration `auto-compact-window`** keeps its `name` (the `schema_version` key; the runner is keyed on name, never version) and stays last in the barrel after upstream's new 022-025. No renumbering. It is now a *portable* migration (upstream froze the SQLite-only set): the idempotency guard uses `DbDriver.columnOwners()` instead of `PRAGMA table_info`. Production, which applied it under this name, skips it; 022-025 apply normally.
  - **`container_configs` carries upstream's `speed` and the fork's `auto_compact_window`** side by side (types, INSERT, column allowlist, `container.json`, agent-runner config, `ProviderOptions`). Per-group `model`/`effort` are untouched.
  - **`NANOCLAW_HOST_GATEWAY_IP`** survives upstream moving the Docker spawn logic behind the driver seam: `src/drivers/index.ts` now calls the fork's `hostGatewayArgs()`, and a new source-level guard catches a revert of that call site.
  - **Webhook loopback bind** kept on top of upstream's new listener (port from `getWebhookPort()`, bind from `WEBHOOK_BIND`, default `127.0.0.1`).
  - **`.env` 0600** kept on top of upstream's new atomic `upsertEnvVars` (upstream copies the old mode across; the fork forces 0600) and `removeEnvVar` routes through `writeSecretEnvFile`. Upstream's `set-env.test.ts` mode assertion flipped to 0600.
  - **`vitest.config.ts`: the auto-merge produced two `setupFiles` keys**, so the fork's silently replaced upstream's `src/test-setup.ts` (196 failing tests, "No agent mailbox registered"). Both are registered now.
  - CI: upstream's `ci`/`gate` jobs plus the fork's `fork-guard-liveness` job (moved to Node 22 / Bun 1.4.0 to match upstream's floor).

- **The vitest suite no longer leaks temp directories.** One `vitest run` left 332 entries in the tmpdir (`nc-skill-*`, `nc-proj-*`, ...), because fixtures `mkdtempSync(tmpdir())` and never remove them; ~4,268 had piled up on devops-vm. Rather than patch every fixture, `src/test/tmp-root.ts` is a `setupFiles` module that gives each test file one private `nc-test-*` root under the original tmpdir, points `TMPDIR` at it (`os.tmpdir()` reads it per call, spawned children inherit it), and removes it in `afterAll`. It also sweeps `nc-test-*` roots older than 6h left by killed runs, on a best-effort basis. It relies on the default `forks` pool (per-process `process.env`). The guard is `src/test/tmp-hygiene.test.ts`. Measured with an isolated `TMPDIR`: 332 entries before, 0 after (Node's own `node-compile-cache` excepted).

- **Offline `ncl` was inert in production: every command returned `unknown-command`.** `dispatch()` resolves commands out of the module-level registry in `src/cli/registry.ts`, which is populated by the SIDE EFFECT of importing `src/cli/commands/index.js`. The host does that once in `src/index.ts`, so the socket path has always had a full registry by the time a frame arrives — the lookup happens in the host process, and the socket CLIENT never needs one. Offline mode dispatches in the client process, where nothing had ever imported that barrel, so the registry was empty: measured at 0 commands before the import and 71 after. The feature that exists to break the upgrade deadlock could not run a single command. **Two separate things let it ship, and the first was not a blind spot at all — it was an override.** [#10](https://github.com/vosburg-auto/nanoclaw/pull/10) ran five panel-review passes — loop-state rows `6cd929209def`, `4689ea21bd67`, `25f158bb9d39`, `01ff18af8367`, `0ba1dc42411b` — and a sixth attempt, row `9f7fda55841c`, recorded outcome `max_iters` with the detail "max_iters already reached across 5 prior pass(es) — no work performed". No row for #10 carries outcome `converged`: the convergence postcondition was never reached, and it was merged on that basis deliberately. So the review process said it was not satisfied and the change went in anyway — this bug is exactly the class of defect an unconverged review can still be carrying, and whether hitting `max_iters` should route to a human instead of an author-declared exception is a live question this fix does not settle. (Those rows live in `~/.local/share/loop-state/panel-review-runs.jsonl`, which is host-local and per-host siloed — the ids are cited so the provenance is one `jq` away on the seat that ran them, rather than resting on this entry's own say-so.) **The second is the blind spot proper:** `src/cli/offline-transport.test.ts` mocks `./dispatch.js`, so the registry is never consulted there — a mock standing in for the exact component whose absence IS the defect cannot detect the defect. The fix is one lazy `import()` before dispatch (lazy, not top-level, because `client.ts` loads this module on every `ncl` invocation and the socket path has no use for the resource tree). The guard is a new fork-owned `src/cli/offline-registry.test.ts` that uses the REAL dispatch against a real temporary database; removing the call turns both of its cases red — the first with the literal `unknown-command` code, which is the production symptom verbatim; the second with the registry length collapsing to zero. Verified end-to-end as well: `NANOCLAW_OFFLINE=1 ncl groups list` now reaches the handler (failing on a missing table in an empty scratch DB) instead of failing to resolve the command. `offline-transport.ts`'s manifest guard now runs both test files, since the mocked one structurally cannot see this class.

- **A sync can silently give back every dependency bump merged since the last one, and nothing here saw it — now `scripts/lockfile-regressions.mjs` does.** `fork-surface.mjs` decides whether a PATH is fork-modified and dispositioned; `pnpm-lock.yaml` is both, so it stays green, and it has no opinion about the VERSIONS inside a dispositioned file. That is not a defect in it — it compares blobs to decide ownership, not contents to decide whether a pin regressed. The gap is not hypothetical: [#7](https://github.com/vosburg-auto/nanoclaw/pull/7) bumped postcss 8.5.10 -> 8.5.25 on `main`, closing two HIGH advisories (arbitrary file read via attacker-controlled `sourceMappingURL`), and this branch had taken upstream v2.1.54's lockfile wholesale — which still pins 8.5.10. Merging the sync would have quietly reinstated the vulnerable version. It was caught by a human reading a version number, which is precisely the detection method this branch has now twice proven does not scale (seven inert guards found by the liveness checker, and an eighth found by CI). The new check compares the MAXIMUM resolved version per package between `main` and the branch and fails on any decrease; a dropped dependency is exempt (a different decision with different review questions) and intentional downgrades go in `docs/lockfile-waivers.json` with a reason. It reports downgrades whether or not an advisory is attached, because "this sync moved a dependency backwards" is what a reviewer needs told either way. Wired into the `ci` job and carried in the manifest with a live guard. Verified against real history rather than a synthetic case: run with `--head 5b0b255a` (the commit before the carry-forward merge) it exits 1 and names all sixteen packages #7 moved. Three mutations confirmed red — lexical instead of numeric version compare, keeping the peer suffix in the lockfile key, and reporting a dropped dependency as a downgrade — each with its anchor asserted before the edit and its application confirmed after.

- **Offline `ncl` and offline schema migrations, so the sanctioned upgrade order is reachable at all.** The runbook stamps the upgrade marker LAST — stamping first writes the new version before the work has happened and disarms `enforceUpgradeTripwire()` exactly when it matters (`docs/upgrade-recovery.md` says the same). But `/migrate-memory` needs `ncl groups list` and `ncl tasks pause`; `ncl` speaks over `data/ncl.sock`, which exists only once the host has booted; and the host refuses to boot until the marker is stamped. Every path either boots with a premature marker or cannot run the migration — a genuine deadlock, not an inconvenience. Two fork-owned pieces resolve it: `NANOCLAW_OFFLINE=1 ncl <args>` routes through a new `OfflineTransport` that dispatches in-process against `data/v2.db`, and `scripts/offline-migrate.ts` runs the central-DB migrations with no host process. **Deliberately a transport and not an `--upgrade-in-progress` boot flag:** a flag whose purpose is to weaken a startup guard is easy and silent to leave set, and the failure mode is a host that looks healthy while the tripwire is disarmed indefinitely. This has no such state — `pickTransport()` was already a seam and `dispatch()` was already transport-agnostic (the socket server and the container poller both call it with a `CallerContext`), so offline mode is a third caller of an existing seam: nothing starts, nothing listens, the process exits with the command. **The `caller: 'host'` context is not a privilege change; the file-permission story around it WAS wrong — see the trust-boundary note below.** The context is the same authority an operator already has running `ncl` against the socket, since the approval gate exists to hold _agent_-initiated calls, never operator ones. It is reached through file-system access to `data/v2.db` instead of `data/ncl.sock`, and those are **not** equivalent gates — that claim is corrected, not merely annotated, below. Containers cannot construct it; the agent-runner never mounts the host data directory. Migration is opt-in and off by default, because the runbook snapshots the DB before any schema change and a transport that migrated on first use would move the schema out from under a snapshot the operator had not taken yet; `offline-migrate.ts` likewise does **not** stamp the marker. Guard is `src/cli/offline-transport.test.ts` — a fork-owned filename, since `src/cli/client.test.ts` is a name upstream owns and this sync proved a wholesale take of such a file deletes feature and detector together. Four mutations verified red: reverting the `client.ts` seam, dispatching as an agent caller, migrating by default, and treating a present-but-empty `NANOCLAW_OFFLINE` as on.

  _(An earlier revision of this bullet asserted the two paths shared "the same owner-only precondition" and a correction was appended two lines below it, leaving the entry contradicting itself. The claim is now fixed in place — appending a rebuttal beside a false sentence is not a correction.)_

  **Trust boundary — corrected mid-PR, because the first version of this entry was wrong.** It claimed DB access carried "the same owner-only precondition" as the socket. It does not: the socket is `0600`, and the live database was found at `0644`, so offline mode would have widened READ access to any local user (writes still require the owner). Rather than restate the assumption, the code now checks it — `assertPrivateDb` refuses a group/world-readable database with the `chmod` to fix it, and `ensurePrivateDb` tightens a database we create rather than trusting the umask. **`assertHostNotRunning`** refuses to run while `data/ncl.sock` exists, on BOTH entry points — the transport and `scripts/offline-migrate.ts`, the latter being the one that actually runs the destructive migration 016. The two overrides are now separate (`NANOCLAW_OFFLINE_FORCE_LIVENESS` / `_PERMS`) so clearing a stale socket does not silently also accept a world-readable DB; the combined `NANOCLAW_OFFLINE_FORCE` still works and warns — and both entry points now call one shared `forced()` rather than a hand-copy, so the warning cannot go missing on the migration path. All of these switches read through a single `envFlag()` parser, because `forced()` had been written with the very truthiness bug (`=false` reading as on) that `offlineRequested()` a few lines above already documented and fixed. Also fixed: `NANOCLAW_OFFLINE=false` ENABLED offline mode (any non-empty value was truthy); `appliedNames()` reported "0 migrations applied" for a database it could not read (SQLITE_BUSY, permissions), the inverse of the truth during a recovery; and the CLI exited without closing the transport on both the success and error paths, skipping SQLite WAL/journal cleanup. Every one of these came from review — a cross-model lens and a six-finding panel consensus — not from the original design.

- **Synced the fork from v2.0.76 to upstream v2.1.54.** The upstream tree is taken wholesale and the fork's patches re-applied on top, rather than merged — the two previous syncs were squash-applied, so git has no merge base for anything they carried and a true merge conflicts on 109 files that are mostly an old upstream copy versus a newer one.
- **Telegram now tracks `upstream/channels` instead of the fork's own copy.** Upstream maintains canonical `telegram.ts`, `telegram-pairing.ts`, and `telegram-markdown-sanitize.ts` there; ours had drifted only by lacking upstream's `TELEGRAM_DEFAULTS` (`ChannelDefaults`) declaration. Without that declaration `getChannelDefaults` falls back to `mention-sticky`, which on a non-threaded platform like Telegram engages once and then stays engaged forever. The fork's `longPolling.allowedUpdates` hunk (reactions + `callback_query`) is re-applied on top and should be sent upstream so this divergence stops recurring.
- **Migration `016-auto-compact-window` moved out of upstream's numeric range** to `fork-auto-compact-window` (version 900), alongside the existing `module-*` migrations — upstream took 016 through 021, and it will keep claiming the next number at every sync. `schema_version` is keyed on the migration _name_, which stays `auto-compact-window`, so installs that already applied it do not re-run the `ALTER`; the migration also gained the `PRAGMA table_info` idempotency guard that 012/016 use, so a future name drift degrades to a no-op instead of crash-looping the host at boot. Both properties are now pinned by upgrade-path tests in `src/db/db-v2.test.ts`.
- **Approval ids are 128-bit CSPRNG again, from one shared `approval-id.ts`.** This sync reverted both sites to `Math.random().toString(36)` and nothing went red, because the only assertion was a base64url character-class check and base36 is a subset of base64url. The generator now lives in a fork-owned module (one carry-forward item instead of two hunks inside upstream-owned files) and `approval-id.test.ts` asserts the decoded byte length. The primitive's prefix is shortened `appr` → `ap`: with a 128-bit body and the `reject_with_reason` button value, the old prefix exceeded Telegram's 64-byte `callback_data` limit by one byte. Nothing parses the prefix.
- **The upgrade tripwire waits ~30s before exiting instead of exiting instantly.** The tripwire runs before the restart-backoff counter so a deterministic refusal is not recorded as a crash — but that ordering also puts it out of reach of the circuit breaker's throttle, so under `Restart=always` with `RestartSec=5` a persistently-tripped install would respawn ~12x/minute and systemd's default `StartLimit` (5 starts / 10s) never fires at that interval. `TRIPWIRE_EXIT_DELAY_MS` restores the throttle without giving the crash counter back. The wait is async, so `systemctl stop` still takes effect during it, and it is not paid on a healthy start. `docs/upgrade-recovery.md` explains the pause so it is not mistaken for a hang.
- **The `.env` no-window test could not fail.** `writeSecretEnvFile` creates the file with `{ mode: 0o600 }` and then `chmodSync`s it — correct, but the test asserted the mode only AFTER the call, so the trailing chmod repaired any creation-time defect and the assertion passed even with the create-time mode dropped: precisely the window the test is named for, invisible to it. It now stubs `chmodSync` and asserts the CREATION mode, and goes red when `{ mode: 0o600 }` is removed. Found by a cross-model (Gemini 3.1 Pro) review — an inert guard inside the PR whose subject is inert guards.
- **The two fork-safety scripts have tests.** `scripts/fork-surface.mjs` and `scripts/fork-guard-liveness.mjs` — the mechanism this sync exists to introduce — had none. Their decision logic is now behind a main-guard and unit-tested (both staleness directions, the superseded exemption, the guard-or-waiver rule, and the broken/inert/live verdict), and the suites were mutation-checked to confirm they can fail. `fork-guard-liveness.mjs`'s own manifest guard was upgraded from `--list`, which only proved the file parsed, to its new test.
- **Webhook server binds loopback again.** The sync reverted `resolveListenConfig`/`DEFAULT_BIND`/`WEBHOOK_BIND` to a hardcoded `0.0.0.0`, and the fork's `webhook-server.test.ts` — the six assertions guarding it — was overwritten by upstream's same-named file, so the feature and its detector died in the same commit with CI green. The guard now lives in `webhook-server.bind.test.ts`; the `hostGatewayArgs` cases moved out of the upstream-owned `container-runtime.test.ts` to `container-runtime.host-gateway.test.ts` for the same reason. **Fork tests belong in fork-owned filenames.**
- **Telegram `unknown_sender_policy` changed from `strict` to `request_approval`** as a consequence of adopting upstream's `telegram.ts`: the pairing interceptor's hardcoded `strict` is now `TELEGRAM_DEFAULTS.{group,dm}.unknownSenderPolicy`, and `src/modules/permissions/index.ts` maps `strict → deny`, `request_approval → hold`. On the live bot an unknown sender in a paired chat now raises an approval card where it previously produced silence. A hold, not an admit — but it is a visible behavior change on first boot.
- **`--auto-compact-window` and `--max-messages-per-prompt` reject a valueless flag.** `src/cli/client.ts` stores `true` for a flag with no following value and `Number(true) === 1` passed the old positive-integer check, so a bare `--auto-compact-window` silently set a 1-token window and that group compacted on every turn after a restart. Both flags now share one `parsePositiveIntFlag` helper.
- **`container_configs` carries both `timezone` (upstream) and `auto_compact_window` (fork).** They landed on the same lines; the INSERT, column allowlist, row type, and `ContainerConfig` all list both.
- **`.env` 0600 hardening restored.** Upstream's rewritten `set-env`/`timezone` setup steps had reverted to bare `fs.writeFileSync`, leaving `.env` (which holds bot tokens) at umask default; both are rewired through the fork's `writeSecretEnvFile`.
- Carried forward unchanged: the baked agent-tooling Dockerfile layer (`ffmpeg`, `gh`, `openssh-client`, `jq`), `NANOCLAW_HOST_GATEWAY_IP`, the `bin/ncl` tsx-resolution block, and the fork's `.gitignore` entries. `@chat-adapter/telegram` is re-added at the `4.29.0` exact pin upstream now requires.
- **New fork-local divergence: ShellCheck annotations on four upstream shell files.** Upstream runs no ShellCheck (no invocation anywhere in the tree, and CI runs only format/typecheck/tests), so two `-S error` defects arrived with the sync: `migrate-v2.sh` wrote its `disable=SC2086` rationale after a `--` separator, which ShellCheck parses as a second directive key and rejects (SC1073); and the three sourced libraries `setup/lib/channels-remote.sh`, `setup/lib/diagnostics.sh`, and `setup/lib/install-slug.sh` have neither a shebang nor a `shell=` directive (SC2148). The fix is comment-only — no runtime change — but these four files were otherwise byte-identical to `upstream/main`, so this is new divergence to re-apply at the next sync and worth sending upstream alongside the `longPolling.allowedUpdates` hunk. Note for anyone extending these: a comment line _beginning_ with the `shellcheck` keyword is parsed as a directive, so rationale prose has to sit on its own line or after a second `#`.

Still unreleased from before this sync (carried, not re-described above):

- **`NANOCLAW_HOST_GATEWAY_IP` points `host.docker.internal` at a remote host.** When set, `hostGatewayArgs()` emits `--add-host=host.docker.internal:<ip>` instead of the platform default, so containers reach the credential proxy and notify endpoints on another box — for installs where nanoclaw does not run on the machine those services live on. An empty value is treated as unset and falls through to the existing behaviour (`host-gateway` on Linux, nothing elsewhere), rather than emitting a malformed flag. Behaviour with the variable unset is unchanged. Adds the first test coverage for `hostGatewayArgs()`.
- **Per-group auto-compact window.** New `container_configs.auto_compact_window` column (migration `auto-compact-window`, shipped as `016` and renumbered by the v2.1.54 sync above) sets the Claude Code auto-compact threshold (tokens) per agent group. Materialized into `container.json` as `autoCompactWindow` and exported as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the agent's SDK env; precedence is per-group config > env override > the built-in 165000 default. Set via `ncl groups config update --id <group> --auto-compact-window <tokens|default>`. Useful for groups running large-context models (Sonnet 5 is natively 1M). No image rebuild needed — agent-runner source is bind-mounted read-only into containers; `ncl groups restart` picks it up.
- **`ncl` no longer hard-requires `pnpm`.** The `bin/ncl` launcher previously ended in an unconditional `exec pnpm exec tsx src/cli/client.ts "$@"`, so a host with dependencies installed but no `pnpm` on `PATH` lost the entire CLI to `exec: pnpm: not found`. It now prefers the checkout's own `node_modules/.bin/tsx` and falls back to `pnpm exec tsx` only when that binary is absent, keeping behaviour identical on dev boxes that have `pnpm` but haven't installed into `node_modules`. When neither runner is available it exits 1 with an actionable message rather than falling back to `npx`, which would fetch `tsx` over the network as a side effect of launching the CLI.

### Upstream

- **Chat SDK channels can recover content the adapter left in the raw payload.** The bridge drops `message.raw` before persisting, so anything a platform did not project into its message text was lost — Slack keeps pasted tables in `attachments[].blocks[]`, and an agent saw only the sentence before the table. A new optional `extractRawText` hook on `ChatSdkBridgeConfig` lets a channel rescue that content as text before raw is discarded. Raw payloads still never reach the database, and a channel that does not set the hook is unaffected.
- **Two install-wide model knobs.** `NANOCLAW_DEFAULT_MODEL` fills in the model for agent groups that have not set one of their own (a group's own model always wins), and `NANOCLAW_FAST_MODE=1` turns on the API's fast serving tier for every agent — faster output at a higher per-token price. Both are read from the host `.env` when container.json is materialized, so a change takes effect at the next container start with no restart of the host. Installs that set neither are unaffected: neither field is written to container.json and the provider sends exactly the options it sent before.
- **Quoted `.env` values now read the same everywhere.** Setup had its own `.env` parser that did not strip surrounding quotes, so a hand-edited `TZ="America/New_York"` or `NANOCLAW_TEMPLATE_PATH="/opt/my templates"` reached the wizard with the quotes still attached — the template path was then bridged into `process.env` unusable. Both readers now share the host parser (`envValue` in `src/env.ts`, the single-key form of `readEnvFile`).

- [BREAKING] **Agents now receive their capability instructions.** `CLAUDE.md` was a list of `@` imports into `/app`; Claude Code silently drops imports resolving outside the project directory, so eight of nine instruction sections never reached the model. It is now one flat file with every source inlined, shared with the Codex provider. Customized source breaks on two surfaces: `src/claude-md-compose.ts` is now `src/project-doc-compose.ts` with `composeGroupClaudeMd(group)` becoming `composeGroupProjectDoc(group, groupDir, spec)`, and the `/app/CLAUDE.md` and `/workspace/agent/.claude-fragments` mounts are gone. **Migration:** `grep -rn "claude-md-compose\|composeGroupClaudeMd\|claude-fragments" src/ setup/ scripts/` — no hits means nothing to do; otherwise repoint the import and pass `DEFAULT_PROJECT_DOC` as the third argument. Then clear the leftovers once: `rm -rf groups/*/.claude-fragments groups/*/.claude-shared.md` — they are inert (nothing reads them) but sit in the agent's working directory.

## [2.3.0] - 2026-08-24

- [BREAKING] **A new Slack experience — per-agent provisioned Slack apps, agent spawning from Slack, and UX improvements — is available to classic single-bot Slack installs.** Classic Slack keeps working unchanged; this gate asks for a decision, not a forced migration. New installs and non-Slack installs are unaffected. **Migration:** run `/migrate-slack-agents` — it detects classic state (exits cleanly otherwise) and either walks the upgrade or records the choice to stay on classic; both outcomes satisfy this requirement.
- **`/add-codex` now pins `@openai/codex` 0.146.0.** The previous pin (0.138.0) defaults to GPT-5.4, which OpenAI retires from Codex on 2026-08-31 — codex-provider agents ride the CLI default model, so stock installs stop completing turns at retirement — and it rejects the newer GPT-5.6 models with a 400 asking for a newer Codex CLI. Existing codex installs are not re-pinned by re-running `/add-codex` (the manifest merge is keyed on package name): edit the `@openai/codex` entry in `container/cli-tools.json` to `0.146.0`, rebuild the agent image (`./container/build.sh`), and restart.
- [BREAKING] **Agent mailbox access now goes through storage-neutral host and runner registries.** The built-in SQLite implementation preserves existing session data and runtime behavior, but custom source may need to replace raw session-database access, await mailbox writes, update moved runner state/heartbeat helpers, drop `DeliveryActionHandler`'s database argument, use booleans for `trigger`/`onWake`, and use the closed inbound-kind set. **Migration:** follow [the agent mailbox seam migration guide](docs/agent-mailbox-seam-migration.md) for the complete detect grep, old→new symbol map, verification, and rollback.
- **Scheduled-task lifecycle semantics are stricter.** Deleting an isolated task cascades its session state, updates refuse already-due runs, recurring selection uses the active series snapshot, and generated task timestamps retain millisecond precision.
- [BREAKING] **The container runtime moves behind the session driver seam.** Session containers are composed as a validated, admission-checked spec and realized by a selectable driver (`src/drivers/`; Docker ships built-in and stays the default). Three surfaces break: **(1) group folder names** align to the runtime label grammar — at most 63 characters of `[A-Za-z0-9_-]`, alphanumeric at both ends — so previously-legal 64-character names, trailing `-`/`_`, and unvalidated legacy imports refuse to spawn; **(2) container names and invocation** change from `nanoclaw-v2-<folder>-<timestamp>` to key-derived `ncl-…` names (the old human-readable name survives as the `nanoclaw-container-name` label) and from `docker run` to `create` + `start --attach` — name-based tooling, Docker-command allowlists, wrappers, and audit rules should match by label instead (`docker ps --filter label=nanoclaw-session`, or `--filter label=nanoclaw-group-folder=<folder>`); **(3) internal container helpers moved** into the driver module — customized installs importing `hostGatewayArgs`, `readonlyMountArgs`, `stopContainer`, `ensureContainerRuntimeRunning`, `cleanupOrphans`, or patching `buildContainerArgs` stop compiling. The `use-native-credential-proxy` skill is retired: the spec's admission rules refuse credential values in container env on every lane, by design — credentials ride the OneCLI vault, and custom Anthropic endpoints use the `ANTHROPIC_BASE_URL` + placeholder-token pattern from setup. **Migration:** run `bun scripts/detect-driver-migration.ts` — it detects all three surfaces in your install and prints one finding per line with a minimal fix instruction; hand the output to your coding agent. Nothing detected means nothing to do.
- **Host restarts now adopt running sessions instead of restarting them.** A service restart no longer kills in-flight agent work; to apply image or runtime changes to a group, restart it deliberately with `ncl groups restart`. Pre-seam containers (spawned before this release) cannot be adopted and are removed at first upgraded startup, exactly as the old startup cleanup did.
- **Container gateway wiring is typed and admission-checked.** The gateway's per-session contribution (proxy env, trust anchors, credential-stub mounts) merges into the session spec before validation instead of riding raw docker flags around it, and gateway selection becomes a registry (`NANOCLAW_GATEWAY_PROVIDER`, default `onecli` — an install that never sets it behaves as it always has).
- **Non-root hosts get an explicit container identity.** Every non-root host now passes `--user <uid>:<gid>` and `HOME=/home/node` (previously uid-1000 hosts relied on the image's `node` user). On uid-1000 systems whose primary gid is not 1000, files the agent writes into mounted workspaces now carry the host's gid — which is the intended behavior.
- **`CONTAINER_MEMORY_LIMIT` is validated at spawn.** Invalid values refuse the spawn with a named error instead of surfacing as a raw Docker error; blank and `0` still mean uncapped.
- **An unknown `NANOCLAW_RUNTIME_DRIVER` aborts startup** (new variable — installs that never set it are unaffected), and drivers that cannot rebuild images in place deny `install_packages` and `--rebuild` at request time instead of failing later.
- [BREAKING] **The host runtime now requires Node.js 22 or newer.** Node 20 is not supported by the upgraded `better-sqlite3` release used for current Node runtimes. **Migration:** run `bash setup/install-node.sh`, verify `node --version` reports v22 or newer, then rerun `/update-nanoclaw`; stay on the previous NanoClaw release if Node cannot yet be upgraded.
- **New NanoClaw installs now use OneCLI gateway 1.41.0.** Existing 1.36.0 gateways remain compatible because NanoClaw does not depend on any 1.41-only behavior. See [the OneCLI upgrade guide](docs/onecli-upgrades.md) to upgrade an existing gateway.
- [BREAKING] **Central database access is now asynchronous behind `DbDriver`.** SQLite remains the default and existing `data/v2.db` files are unchanged, but custom source and installed channel/provider extensions must await central reads and writes and adopt the retyped host seams. **Migration:** follow [the central database async migration guide](docs/central-db-async-migration.md) to find affected calls, preserve transaction boundaries, update extensions, verify SQLite behavior, or roll back.
- **Central DB composition and migrations are backend-ready.** A one-slot driver registry keeps backend selection in `src/db/compose.ts`; `pnpm run migrate` is the explicit schema-change path, host validation can fail closed without DDL, and a shared conformance suite pins transaction, parameter, ordering, and timestamp behavior. SQLite remains the installed default.

## [2.2.0] - 2026-08-13

- **Stamped plugins update in place through `ncl groups create --template <ref>`.** When a group already carries the template's plugin, the same command becomes an in-place update instead of minting a duplicate agent: a dry run prints a plan of every plugin-owned surface (plugin files, skills, MCP servers, persona, context files, tasks), flagging locally customized files whose edits would be lost; `--yes` applies, `--id` picks among several stamped groups, `--new` deliberately stamps another agent. Agent state the plugin does not own (memory, `plugin-data/`, user-added MCP servers, task pause/resume state, wiring) is never touched. Plugin-stamped MCP servers now carry an ownership marker and refuse direct edits via `ncl groups config add-mcp-server` / `remove-mcp-server` or the agent's `add_mcp_server` tool: update the plugin and restamp instead.
- [BREAKING] **Agent templates are now Agent Plugins 1.0.0 directories.** `plugin.json` replaces `context/instructions.md` as the required file; MCP servers move to a spec-shaped `mcp.json`; persona, extra context, and tasks move under the `ai.nanoco.nanoclaw/` extension dir. Templates become portable to other plugin clients, and any conformant third-party plugin stamps as a NanoClaw agent. **Migration:** re-fetch templates from the registry (the pre-plugin layout fails with a migration error); to convert a local custom template, see [docs/templates.md](docs/templates.md).
- **Plugin MCP servers may declare a working directory.** `cwd` in `mcp.json` (fixed forms `./p`, `${PLUGIN_ROOT}[/p]`, `${PLUGIN_DATA}[/p]`) now launches the server in that directory instead of being skipped: resolved to an absolute container path at runtime, consumed natively by providers that support it and via a `cd`-then-`exec` launch shim on Claude. A stdio server that omits `cwd` runs from the plugin root (the spec default).
- **Setup can stamp the first agent from a template.** The wizard offers the NanoClaw template library (or local `templates/`) when creating the first agent; `--template-path <ref>` or the advanced screen presets the pick. A rerun over a partial install updates the stamped agent in place (dry-run plan + confirm) instead of duplicating it, the pick persists across wizard re-execs and reruns, and a template failure warns and continues instead of aborting setup.
- **Remote MCP servers can use Streamable HTTP.** Register them with `ncl groups config add-mcp-server --name <name> --url <url>` or the existing admin-approved `add_mcp_server` tool. Local stdio MCP commands keep their current `command` / `args` / `env` behavior; remote credentials remain OneCLI-managed: URLs with userinfo, fragments, or credential-looking query parameters are rejected. HTTPS is required except for `localhost` / `host.docker.internal`.
- [BREAKING] **Host modules now use one lifecycle registry.** Custom modules that import `onShutdown()` or `getShutdownCallbacks()` from `response-registry.ts` must move to the host lifecycle API. **Migration:** follow [the host lifecycle migration guide](docs/host-lifecycle-migration.md) to detect affected code, update it, verify the cutover, or roll back.
- **Agent-to-agent messaging no longer loses to Claude Code's built-in `SendMessage`.** That built-in addresses the SDK's own in-session subagents, so an agent that had just run `create_agent` reached for it by name and got `No agent named 'x' is currently addressable` — reading as "the group was never provisioned" while `mcp__nanoclaw__send_message` (the real path) was never called. `SendMessage` joins `AskUserQuestion` in `SDK_DISALLOWED_TOOLS`, so the PreToolUse hook now blocks it and points at the nanoclaw equivalent.
- **Security: agent-image toolchains bumped past a critical `tar` vulnerability (GHSA-23hp-3jrh-7fpw).** pnpm moves to 10.34.5 (host `packageManager` and container `PNPM_VERSION` in lockstep) and the container pins npm 10.9.9 over the base image's 10.9.8, replacing the vulnerable vendored `tar` in both. Rebuild the agent image to pick it up; no behavior change.
- [BREAKING] **Existing Claude installs should review the hardened agent image.** Local builds remain supported, but the Echo-built image is recommended for patched sandbox components. **Migration:** follow [the hardened-image guide](docs/hardened-image.md) to detect your current image source, switch, verify, or roll back.
- **Release publication tolerates GitHub API propagation.** The Release workflow now retries bounded post-publication read-backs when the new Release is not listed yet or its immutable state is not visible yet. Exact title, body, tag, or SHA mismatches still fail immediately.
- The `add-tavily-tool` skill adds Tavily Search and Extract as keyless remote MCP tools for selected agent groups, bridged through a pinned `mcp-remote`.
- Scheduled tasks now run with their effective scheduled occurrence as the task time, plus a task-only `current_time` (weekday included, in the agent group's timezone) instead of the creation timestamp.
- Accumulated messages stay available as context without spuriously triggering warm-container follow-up turns; group-scoped agents can inspect their wirings and request approved engagement-policy updates; invalid engagement regexes are rejected.
- Hosted iMessage setup now provisions the line's user row directly and prints the assigned number to text once; that first message is the opt-in the delivery plane checks, and re-runs reuse the existing row.
- Resolved approval cards keep their title and request details, replace buttons with the decision and actor (or a timeout status), and survive host restarts and delayed resolution.
- Setup failure assist now offers diagnosis through the provider the operator picked instead of always offering to install Claude.
- `ensureUserDm` gains an opt-in privacy-safe logging mode for security-sensitive flows: user IDs, handles, messaging-group IDs, and raw adapter errors are omitted while non-identifying channel context is kept.
- The stale `add-gcal-tool`, `add-gmail-tool`, and `get-qodo-rules` skills were removed.
- The recommended hardened agent image is repinned to `hardened-2026-08-13`.
- The package description now says personal AI assistant: NanoClaw is provider-agnostic, not Claude-only.
- Docs: skills define a single-responsibility integration rule, and the hardened-image guide states that `install_packages` covers apt and npm packages only.

## [2.1.54] - 2026-08-01

Rollup release covering v2.1.18 through v2.1.54 — everything merged since the v2.1.17 tag.

- [BREAKING] **iMessage unified into one `imessage` channel with two backends via `/add-imessage`:** Local (this Mac's `chat.db` via the Chat SDK) or Hosted (native [Photon](https://photon.codes) via `spectrum-ts`, no Mac relay). Backend chosen at install or via `IMESSAGE_BACKEND=local|hosted`. The legacy Chat-SDK remote mode (`IMESSAGE_SERVER_URL`/`IMESSAGE_API_KEY`) and the separate `imessage-cloud` channel + `/add-imessage-cloud` skill are **removed**. See [docs/imessage.md](.claude/skills/add-imessage/docs.md).
- [BREAKING] **Provider-agnostic memory.** All providers now share one OKF v0.1-compatible `memory/` tree, while persona lives in `instructions.prepend.md`; startup, clear, and compact reload memory automatically. Existing groups with legacy memory must run `/migrate-memory` before use. See [memory](docs/memory.md) and [provider migration](docs/provider-migration.md).
- **New groups can inherit an instance-wide default provider.** `DEFAULT_AGENT_PROVIDER` sets the provider used when a new agent group is created without an explicit provider. Each group's stored provider still overrides it, and existing groups are unchanged.
- [BREAKING] **Channel install skills are now the single source of truth.** The setup wizard installs channels by applying the same `/add-<channel>` SKILL.md a coding agent would follow — a deterministic engine executes the skill's mechanical steps directly from the document, so wizard and skill cannot drift, and anything the engine cannot do falls back to an agent reading the prose. **Migration:** the bespoke non-interactive channel installers (`setup/add-<channel>.sh`, `setup/install-<channel>.sh`) and per-channel wizard flows (`setup/channels/<channel>.ts`) are deleted. Anything that invoked them should apply the skill instead: interactively via `/add-<channel>` or the setup wizard, or programmatically via [skill directives](docs/skill-directives.md).
- **One guard for privileged actions.** Every privileged action crossing the container or channel boundary now passes through `guard()` before execution: `allow`, `hold`, or `deny`. Approved replays carry the approval row as a grant and re-run checks against current state; forged, consumed, mismatched, or newly unauthorized grants fail closed. Guarded delivery actions can no longer be re-registered without their guard specification.
- [BREAKING] **`whatsapp-formatting` and `slack-formatting` moved from trunk to the `channels` branch.** They now install with their channel, so installations without those channels no longer carry channel-specific formatting instructions in every agent's context. **Migration — only if the channel is installed:** re-run `/add-whatsapp` or `/add-slack` after updating. Do not run an add-skill preemptively; it installs the full adapter.
- [BREAKING] **Scheduled tasks moved from MCP tools to `ncl tasks`.** Agents and operators now manage tasks with `ncl tasks list/get/create/update/cancel/pause/resume/delete/run/append-log`; task sessions are isolated from the chat session that created them. **Migration:** follow [the scheduled-task migration guide](docs/ncl-tasks-migration.md).
- [BREAKING] **Task delivery is explicit and uses one door.** Every `send_message` and `send_file` call requires a named `to` destination; task-session final output becomes the run summary, while only explicitly addressed tool calls deliver. **Migration:** rebuild the agent image, restart NanoClaw, update custom instructions that omit `to`, and clear or compact existing sessions. Failed pre-task scripts now back their recurring series off and auto-pause after eight consecutive failures instead of spinning.
- [BREAKING] **Chat SDK and channel adapters are pinned to `4.29.0`.** The bridge and adapter must use the same `ChatInstance` type, so exact pins replace caret ranges. Core installations without a channel are unaffected. **Migration:** if a channel is installed, re-run its `/add-<channel>` skill after updating.
- **Hardened agent images are available as an opt-in setup path.** A digest-pinned, multi-architecture image can be fetched from the NanoClaw registry and retagged to the same local name used by builds; architecture, lockfile, provenance, size, and optional publisher-signature checks fail closed. Local builds remain the default and require no account. See [hardened images](docs/hardened-image.md).
- **Agent containers now start with safer defaults.** New spawns always drop all Linux capabilities, set `no-new-privileges`, and use Docker's init process; these controls have no per-group override. A PID limit defaults to 2048 and can be changed installation-wide with `CONTAINER_PIDS_LIMIT` (`0` disables it). The Vercel CLI is now opt-in instead of being baked into every image.
- **Agent containers can have installation-wide resource caps.** `CONTAINER_CPU_LIMIT` and `CONTAINER_MEMORY_LIMIT` pass `--cpus` and `--memory` to Docker for every agent container. Both remain empty by default, so existing installations keep their current behavior.
- **Per-agent-group timezones.** `ncl groups config update --timezone <IANA>` overrides the install timezone for that group's scheduling, run-log display, and container `TZ`; `""` clears the override. Host-side operator display remains in the install timezone.
- **Agent templates and reusable skills expanded.** Local templates can stamp persona, context, MCP configuration, and skills through `ncl groups create --template`; templates can also seed scheduled tasks and timezone. `/learn` distills a reusable skill from an existing workflow, and `/add-clidash` installs a read-only CLI-derived dashboard.
- **A clearer, safer `ncl` control plane.** Verbs now declare and validate their arguments, generate deep help, preserve dashed IDs, render human-readable output on the host, and flush large responses before exit. Creating groups and wirings now provisions their required companion rows transactionally, fixing first-spawn failures and silently dropped replies.
- **Approval and agent-to-agent controls are more expressive.** Connected agents can require per-message approval; rejection reasons reach the requester; OneCLI approval cards use the gateway's structured summary; and shared-channel cards retain who approved or rejected an action.
- **Delivery and provider failures stop disappearing.** Missing adapters route messages into retry instead of marking them delivered, agent image builds no longer block the host, and Claude rate-limit telemetry only aborts a turn when the SDK reports a rejection. Billing exhaustion and transient rate limits remain distinct.
- **Setup and update recovery improved.** Setup can parse wrapped Claude OAuth captures, offer Slack Socket Mode, and reap dead peer-service registrations. Re-applying an updated skill rebuilds the container when needed, and a missing session folder is re-provisioned so the documented reset path works.
- **Security fixes.** Inbox attachment writes reject symlink escapes, approved CLI calls preserve the original caller context, command-gate checks no longer fail open, mount allowlists honor `readOnly`, and stale v1 secret/config mirrors were removed.
- Documentation was refreshed across architecture, database schemas, security boundaries, provider configuration, SDK behavior, skills, and registry-branch maintenance. A Korean README is now available.

## [2.1.17] - 2026-06-17

Rollup release covering v2.1.1 through v2.1.17 — every `package.json` bump merged since the v2.1.0 tag. This section restores the changelog entry from the already-published [v2.1.17 GitHub Release](https://github.com/nanocoai/nanoclaw/releases/tag/v2.1.17).

- [BREAKING] **`@onecli-sh/sdk` 0.5.0 → 2.2.1 requires a OneCLI server with the `/v1` API.** Older servers return 404 for every SDK call. The sanctioned gateway and CLI versions are pinned in `versions.json`, and the `onecli` setup step enforces them. **Migration:** `/update-nanoclaw` upgrades the gateway when its pin moves; otherwise follow [the OneCLI upgrade guide](docs/onecli-upgrades.md).
- **New Codex agent provider.** Run `/add-codex` to install the `codex app-server` provider from the `providers` branch. Authentication remains vault-only; no credential enters a container.
- **Setup can select, install, and authenticate a non-default agent provider.** The selected provider is stored on the first agent before its first spawn. Picking the default Claude provider changes nothing.
- **Provider choice is explicit per group.** Change it with `ncl groups config update --provider`, then restart the group.
- **Provider memory moves through `/migrate-memory`.** Runtime does not copy provider-owned stores automatically; follow [the provider migration guide](docs/provider-migration.md).
- **`/update-nanoclaw` upgrades the OneCLI gateway when its sanctioned pin moves.** Hosts whose gateway pin did not change are unaffected.
- **Budget and billing errors reach the user.** Non-retryable provider errors without message wrapping are delivered to the originating channel instead of entering a silent retry loop.
- **Command-gate denials reach the sender.** Host-side outbound writes now use the read-write opener, fixing a `SQLITE_READONLY` failure that silently dropped denial responses.
- **Slash commands interrupt an in-flight turn.** Runner-handled commands such as `/clear`, `/compact`, and `/cost` no longer wait for the current turn to finish.
- **Container boot failures say why.** A stderr tail is logged at warning level when a container exits non-zero instead of disappearing below the default log level.
- **Opt-in egress lockdown.** Containers can fail closed against a configured outbound allowlist. See [the security model](docs/SECURITY.md#5-egress-lockdown-forced-proxy).
- **Channel instances are first-class.** One channel kind can run multiple independent instances with separate credentials, Chat SDK state, and webhook routes; existing single-instance installs remain compatible.
- **Native uninstaller.** `bash uninstall.sh` or `nanoclaw.sh --uninstall` removes the service, data directory, host registration, and OneCLI agent registration for that installation. Dry-run and confirmation modes are included.
- **Interactive setup handoffs preserve context.** Failure and `?` handoffs now provide the context as Claude's first user prompt and retain one session across handoffs.
- **Raw webhook route registry.** Channels can register HTTP routes without editing the host route table.
- **Typed delivery-action and approval-resolved registries.** Channels can expose delivery actions and receive approval-resolution callbacks without channel-specific branching at the host call site.
- **Provider-owned per-exchange archiving.** The agent runner exposes `onExchangeComplete`; providers opt into their own archival behavior.
- [security] **A2A attachment resolution rejects symlink escapes** from the per-group sandbox.
- [security] **Approval responses require an authorized admin** whose scope covers the request's group.
- [security] **Agent creation is authorized on the host** as well as the API edge; confined groups require host-side approval.
- `host-sweep` respects a per-group wake grace instead of tearing down a container that just woke with a stale processing claim.
- Global container CLI installs are data-driven through `container/cli-tools.json`; `agent-browser` is pinned to `0.27.1`.
- Four v1-only skills were retired: `claw`, `x-integration`, `add-parallel`, and `convert-to-apple-container`.
- The skills installation model is documented in [the skills model](docs/skills-model.md), and twelve skills were updated to the current contract.
- An Ollama prompt-cache guide was added for the Claude Code → Ollama path. See [Ollama](docs/ollama.md).
- Resolved approval and question cards in shared channels retain the acting user's name.
- `@anthropic-ai/claude-code` and `@anthropic-ai/claude-agent-sdk` were updated to `2.1.170` and `0.3.170`.

## [2.1.0] - 2026-06-07

- [BREAKING] **Startup now requires an upgrade marker.** The host refuses to boot unless `data/upgrade-state.json` records that this install reached the current version through a sanctioned path (`/setup`, `/update-nanoclaw`, `/migrate-nanoclaw`). After this update completes — and before restarting the service — stamp the marker by running `pnpm exec tsx scripts/upgrade-state.ts set`. If the host has already tripped on restart with "update did not go through the supported path", that same command clears it. See [docs/upgrade-recovery.md](docs/upgrade-recovery.md).

## [fork-sync 2.0.76] - 2026-06-06

Synced the vosburg-auto fork to upstream `qwibitai/nanoclaw` **v2.0.76** (from v2.0.71). 16 upstream commits merged; the only conflict was `package.json` (version), auto-resolved. All fork customizations carried forward unchanged: the Telegram channel (`telegram.ts`, `telegram-pairing.ts`, markdown sanitizer), the `context-awareness` / `gemini-companion` / `opus-escalation` container skills, OneCLI approval handling, webhook-server changes, and the Dockerfile apt-package bake.

- Picks up upstream's `/upload-trace` command (uploads a session trace to Hugging Face) plus minor `init-onecli` skill, formatter, and command-gate fixes.
- No container image rebuild required — the agent-runner source (where the new `upload-trace.ts` / `poll-loop.ts` changes live) is mounted read-only from the working tree, and neither the Dockerfile nor agent-runner deps changed.
- Verified: `pnpm typecheck` clean, `pnpm build` clean, 386/386 tests passing; host service restarted on the new build.

## [2.0.64] - 2026-05-18

- **`ncl destinations add` and `remove` through the approval flow now reach the receiver immediately.** Approved destinations weren't being projected into the receiving agent's local session state, so a freshly-added destination silently failed at `send_message` with `unknown destination`, and a removed destination stayed resolvable until the next container restart. Both now take effect the moment the approval executes. Direct (non-approval) calls were unaffected.

## [2.0.63] - 2026-05-15

Rollup release covering v2.0.55 through v2.0.63 — everything merged since the v2.0.54 tag. Starting with this release, the goal is to publish a GitHub Release for every `package.json` version bump that lands on `main`; see [RELEASING.md](RELEASING.md).

- [BREAKING] **Service names are now per-install.** On v2 installs the launchd label and systemd unit are slugged to your project root: `com.nanoclaw.<sha1(projectRoot)[:8]>` and `nanoclaw-<slug>.service`. The old `com.nanoclaw` / `nanoclaw.service` names no longer match a real service — update any copy-pasted restart or status commands. Find your install's names with `source setup/lib/install-slug.sh && launchd_label` (macOS) or `systemd_unit` (Linux). The `ncl` transport-error help text and 26 skill files now use the canonical helper-driven pattern; see [setup/lib/install-slug.sh](setup/lib/install-slug.sh).
- **Compaction destination reminder placement fixed.** The reminder injected after SDK auto-compaction now appears at the end of the compaction summary so it isn't stripped during truncation. Replaces the placement shipped in v2.0.54.
- **Stronger message-wrapping enforcement.** The poll loop nudges the agent when its output lacks `<message>` wrapping, and `CLAUDE.md` core instructions now require wrapping even for single-destination agents. The welcome flow no longer double-greets.
- **OneCLI credentials after MCP install.** MCP servers added through `add_mcp_server` now inherit OneCLI gateway routing — fixes the case where the agent kept asking for API keys after installing a new server.
- **CLI scope hardening.** `scopeField` now fails closed when scope is missing, and `sessions get` is guarded against cross-group oracle access from group-scoped agents.
- **gmail/gcal skills aligned with v2.** `/add-gmail-tool` and `/add-gcal-tool` now reflect the v2 container-config model — DB-backed mounts, no dead `TOOL_ALLOWLIST` edits, no `container.json` writes that get clobbered on next spawn. Manual sqlite3/JSON1 invocations corrected.
- **Repo-rename cleanup.** Remaining `qwibitai/nanoclaw` references swept to `nanocoai/nanoclaw` across code and docs; CI workflow guards updated so they no longer no-op after the rename.
- Slack scope checklist now includes `files:read` and `files:write` for skills that read or post attachments.
- The internal-tag description in destination instructions no longer mentions scratchpads (which confused agents into routing them incorrectly).
- Container startup is now graceful when the `on_wake` column is missing on older sessions DBs.

## [2.0.54] - 2026-05-10

- **Per-group model and effort overrides.** Agent groups can now run a specific Claude model and effort level, set via `ncl groups config update --model <model> --effort <level>`. Defaults to the host-configured model when unset.
- **Claude Code 2.1.128.** Container claude-code bumped from 2.1.116 to 2.1.128.
- CLI help text improvements for `ncl groups config` and `ncl groups restart`.

## [2.0.48] - 2026-05-09

- **Container config moved to DB.** Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, skills) now lives in the `container_configs` table instead of `groups/<folder>/container.json`. Existing filesystem configs are backfilled automatically on startup. Managed via `ncl groups config get/update` and `config add-mcp-server/remove-mcp-server/add-package/remove-package`.
- **Explicit restart with on-wake messages.** Config CLI operations no longer auto-kill containers. New `ncl groups restart` command with `--rebuild` and `--message` flags. On-wake messages (`on_wake` column on `messages_in`) are only picked up by a fresh container's first poll, preventing dying containers from stealing them during the SIGTERM grace period. Self-mod approval handlers (`install_packages`, `add_mcp_server`) use the same race-free mechanism.
- **Per-group CLI scope.** New `cli_scope` setting on container config (`disabled` / `group` / `global`, default `group`). Controls what the agent can access via `ncl` from inside the container. `disabled` excludes CLI instructions from CLAUDE.md and blocks all requests. `group` (default) restricts to own-group resources with auto-filled args. `global` gives unrestricted access (set automatically for owner agent groups). Includes post-handler result filtering to prevent cross-group data leaks and blocks `cli_scope` escalation from group-scoped agents.

## [2.0.45] - 2026-05-08

- **Admin CLI (`ncl`).** New `ncl` command for querying and modifying the central DB — agent groups, messaging groups, wirings, users, roles, members, destinations, sessions, approvals, and dropped messages. Host-side transport via Unix socket; container-side transport via session DB. Write operations from inside containers go through the approval flow. `list` supports column filtering and `--limit`. Run `ncl help` for usage.
- **v1 → v2 migration.** Run `bash migrate-v2.sh` from the v2 checkout. Finds your v1 install (sibling directory or `NANOCLAW_V1_PATH`), merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders (`CLAUDE.md` → `CLAUDE.local.md`), copies session data with conversation continuity, ports scheduled tasks, interactively selects and installs channels (clack multiselect), copies container skills, builds the agent container, and offers a service switchover to test. Hands off to Claude (`/migrate-from-v1`) for owner seeding, access policy, CLAUDE.md cleanup, and fork customization porting. See [docs/migration-dev.md](docs/migration-dev.md) and [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md).

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
