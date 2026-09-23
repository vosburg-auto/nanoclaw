/**
 * `ncl` binary entry point.
 *
 * Parses argv, builds a request frame, sends it via the picked transport,
 * formats the response, exits non-zero on error.
 *
 * Usage:
 *   ncl <resource> <verb> [target] [--key value ...] [--stdin-json] [--json]
 *
 * Examples:
 *   ncl groups list
 *   ncl groups get abc123
 *   ncl groups create --name foo --folder bar
 *   ncl groups update abc123 --name baz
 *   ncl help
 *   ncl groups help
 */
import { randomUUID } from 'crypto';

import { formatResponse } from './format.js';
import type { RequestFrame } from './frame.js';
import { OFFLINE_ENV, OfflineTransport, offlineRequested } from './offline-transport.js';
import { parseArgv } from './parse-argv.js';
import { SocketTransport } from './socket-client.js';
import { readStdinJsonArgs, StdinJsonInputError } from './stdin-json.js';
import type { Transport } from './transport.js';
import { formatTransportError } from './transport-errors.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, args, json, stdinJson } = parseArgv(argv);
  if (command.length === 0) {
    process.stderr.write('ncl: missing command\n');
    printUsage();
    process.exit(2);
  }

  let requestArgs = args;
  if (stdinJson) {
    if (process.stdin.isTTY) {
      // Reading a TTY would silently block until the user types Ctrl-D.
      process.stderr.write('ncl: --stdin-json requires piped stdin (e.g. `echo {...} | ncl ...`)\n');
      process.exit(2);
    }
    try {
      requestArgs = await readStdinJsonArgs(process.stdin, args);
    } catch (err) {
      if (!(err instanceof StdinJsonInputError)) throw err;
      process.stderr.write(`ncl: ${err.message}\n`);
      process.exit(2);
    }
  }
  // Stdin is only a client-side encoding for args. The daemon receives the
  // same stable request frame it would receive if every value came from argv.
  const req: RequestFrame = { id: randomUUID(), command, args: requestArgs };
  const transport: Transport = pickTransport();

  let res;
  try {
    res = await transport.sendFrame(req);
  } catch (e) {
    process.stderr.write(formatTransportError(e));
    // Same reason as the success path below: the offline transport holds an open
    // SQLite handle and process.exit() skips WAL/journal cleanup. The error path
    // needs it MORE — sendFrame may have failed after the DB was opened.
    try {
      await transport.close?.();
    } catch {
      /* cleanup must never mask the transport error we are already reporting */
    }
    process.exit(2);
  }

  // formatResponse INSIDE the guarded region: it ran outside, so a formatting
  // throw fell through to the top-level catch and never closed the transport —
  // a residual hole in the very "close on every path" fix this file makes.
  let output: string;
  try {
    output =
      !json && res.ok && res.human !== undefined
        ? res.human + '\n' // server-rendered view — print verbatim
        : formatResponse(res, json ? 'json' : 'human');
  } catch (e) {
    process.stderr.write(`ncl: could not format the response: ${e instanceof Error ? e.message : String(e)}\n`);
    try {
      await transport.close?.();
    } catch {
      /* cleanup must never mask the formatting error */
    }
    process.exit(2);
  }
  // Exit only after stdout drains: process.exit() discards buffered pipe
  // writes, silently truncating any response past the 64KB pipe buffer
  // (bit `ncl sessions list --json` at scale).
  // Close before exiting: the offline transport holds an open SQLite handle,
  // and process.exit() would skip WAL/journal cleanup. close() is a no-op on the
  // socket transport and on an offline transport that never opened.
  const done = async () => {
    try {
      await transport.close?.();
    } catch {
      /* cleanup must never change the command's exit status */
    }
    process.exit(res.ok ? 0 : 1);
  };
  process.stdout.write(output, () => void done());
}

function pickTransport(): Transport {
  // Fork patch (vosburg-auto): NANOCLAW_OFFLINE routes `ncl` at data/v2.db
  // instead of data/ncl.sock, so the upgrade runbook can run `ncl groups list`
  // / `ncl tasks pause` BEFORE the host is allowed to boot. Without it the
  // sanctioned order is unreachable — see src/cli/offline-transport.ts for the
  // deadlock and why this is a transport rather than a boot flag.
  if (offlineRequested()) return new OfflineTransport();
  return new SocketTransport();
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: ncl <resource> <verb> [target] [--key value ...] [--stdin-json] [--json]',
      '',
      '  --stdin-json  Read one bounded JSON object from stdin and merge it with argv flags.',
      '',
      'Run `ncl help` to list available resources and commands.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`ncl: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
