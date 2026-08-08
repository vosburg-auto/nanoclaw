/**
 * Client-side transport interface. The `ncl` binary picks one of these and
 * calls sendFrame; the caller doesn't know whether bytes traveled over a
 * Unix socket (host) or through outbound.db / inbound.db rows (container).
 */
import type { RequestFrame, ResponseFrame } from './frame.js';

export interface Transport {
  sendFrame(req: RequestFrame): Promise<ResponseFrame>;
  /**
   * Release any resources held by the transport. OPTIONAL — a socket transport
   * has nothing to release, but the offline transport holds an open SQLite
   * handle, and `process.exit()` would skip its WAL/journal cleanup. Callers
   * should invoke it before exiting and must tolerate its absence.
   */
  close?(): void;
}
