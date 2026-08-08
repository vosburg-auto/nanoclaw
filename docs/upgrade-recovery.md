# Recovering from the upgrade tripwire

If NanoClaw refuses to start with a message like *"update did not go through the supported path"*, this page explains what happened and how to clear it.

## What happened

NanoClaw records the version it reached each time you upgrade through a supported path — `/setup`, `/update-nanoclaw`, or `/migrate-nanoclaw`. That record lives in `data/upgrade-state.json`.

At startup the host checks that record against the running code. If it's **missing** or its version **doesn't match** the code, the host stops. This almost always means the code was updated by a raw `git pull` instead of the supported flow — so migrations, dependency installs, or container rebuilds that the flow would have run may not have happened.

**Why it pauses before quitting.** After printing the message the host waits ~30 seconds, then exits non-zero. That is deliberate: if NanoClaw is under a supervisor that restarts it (systemd `Restart=always`, a container restart policy), an install that stays tripped would otherwise respawn every few seconds and flood the log. The pause makes a stuck install restart at a readable pace. It does not delay a healthy start, and `systemctl stop` still takes effect during the wait.

## If you just ran a supported upgrade

If you reached this point by running `/update-nanoclaw`, `/migrate-nanoclaw`, or `/setup` and it **completed successfully**, this is expected the first time an existing install meets the tripwire (your previous version predated it). Clear it by stamping the current version:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
```

Then restart NanoClaw. It won't trip again.

**Coding agents:** if the upgrade you just ran reported success, run the command above automatically and restart. Only stop to ask a human if the upgrade itself failed or you can't confirm it finished.

## If you ran `git pull` yourself

Don't just clear the tripwire — that skips the work the supported flow does. Instead, run the supported upgrade so backups, migrations, and rebuilds happen:

```
/update-nanoclaw
```

Once it finishes it stamps the marker for you, and the next start is clean.

## If you have your own upgrade flow

If you've built your own way to upgrade — a custom skill, a deploy script, a CI job, a service that pulls and restarts — it won't stamp the marker, so the host will trip on the next start. Add the stamp as the **last step** of that flow, after the upgrade succeeds and before the restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
```

That's the same thing `/setup`, `/update-nanoclaw`, and `/migrate-nanoclaw` do at the end. Do it only when the upgrade actually completed — the marker is your assertion that this install reached the current version through a path you trust.

### When the upgrade steps themselves need `ncl` (fork addition)

"Stamp last" and "the host won't boot until you stamp" are in direct tension the moment an upgrade step needs the host. `/migrate-memory` is exactly that case: it calls `ncl groups list` and `ncl tasks pause`, and `ncl` speaks over `data/ncl.sock`, which only exists after boot. Doing those steps in the sanctioned order is otherwise impossible.

Run them offline instead. Neither command starts a listener, opens a channel, or writes the marker:

```bash
# Schema migrations, no host process. TAKE THE DB SNAPSHOT FIRST —
# migration 016 drops and recreates messaging_groups with no down migration.
pnpm exec tsx scripts/offline-migrate.ts --check    # report only
pnpm exec tsx scripts/offline-migrate.ts            # apply

# Any ncl command, dispatched in-process against data/v2.db.
NANOCLAW_OFFLINE=1 ncl groups list
NANOCLAW_OFFLINE=1 ncl tasks pause <series-id> --group <group-id>
```

Then finish the upgrade and stamp the marker last, as above.

Offline `ncl` runs as a **host** caller, which is the same authority you already have running `ncl` against `data/ncl.sock` — the approval gate holds agent-initiated calls, not operator ones. It reaches that authority through file access to `data/v2.db` rather than to the socket.

**Those two are not the same gate**, and an earlier version of this page said they were. The socket is `0600` (owner only); a database left at `0644` is readable by any local user, so offline mode would hand host-level READ access to someone the socket would have refused. (Writes still need the owner.) So the transport checks instead of assuming: it refuses to run against a group/world-readable database and prints the `chmod 600` to fix it, and a database it creates itself is chmod'd private rather than left to your umask.

**Two more refusals you may hit, both deliberate:**

- *"the host appears to be running"* — `data/ncl.sock` exists. Offline mode writes the database directly while the host caches state in memory, so changes made now can be silently overwritten, and an offline migration would move the schema under a live process. Stop the host. If the socket is stale after an unclean kill, set `NANOCLAW_OFFLINE_FORCE_LIVENESS=1`.
- *"readable by group/other"* — run the `chmod 600` it prints, or set `NANOCLAW_OFFLINE_FORCE_PERMS=1` if you have accepted the exposure on that host.

`NANOCLAW_OFFLINE_FORCE=1` still works but waives **both**, which is rarely what you mean — it warns when used.

Containers cannot use any of this: the agent-runner never mounts the host's data directory.

## The override

`pnpm exec tsx scripts/upgrade-state.ts set` is the override: it declares "this install is good at the current version." Use it when you know the install is actually in a good state (e.g. you completed the steps manually). It's safe to re-run.

To inspect the current marker:

```bash
pnpm exec tsx scripts/upgrade-state.ts get
```
