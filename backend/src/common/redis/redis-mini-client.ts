/**
 * Minimal RESP-2 Redis client. Speaks just enough Redis to satisfy
 * the `RedisLike` interface used by `RedisRateLimitStore` (i.e.,
 * `eval(script, numKeys, ...args)` returns the Redis reply).
 *
 * Why a hand-rolled mini-client (instead of `ioredis`):
 *   - We use ONE Redis verb (EVAL). `ioredis` is ~3 MB unpacked + has
 *     its own connection lifecycle that we'd have to monkeypatch for
 *     ECS task lifecycle anyway.
 *   - RESP-2 is small + well-documented:
 *     https://redis.io/docs/latest/develop/reference/protocol-spec/
 *   - Pure stdlib (`node:net`, `node:events`). One file, no transitive
 *     deps. The whole thing is auditable in 15 minutes.
 *
 * Connection model:
 *   - Single TCP socket, lazy-connected on first request.
 *   - Pipelined: requests are written immediately; replies come in the
 *     same order they were sent. We track an in-flight queue so multiple
 *     concurrent `eval()` calls don't tangle their replies.
 *   - On socket error / close, the in-flight queue is rejected with a
 *     clear error and the next call reconnects.
 *   - `quit()` issues QUIT + closes the socket cleanly.
 *
 * What we DON'T support:
 *   - PUBSUB (would need a second connection).
 *   - SUBSCRIBE / PSUBSCRIBE.
 *   - Cluster / Sentinel.
 *   - TLS (caller can supply a `tls.Socket` via `dial`).
 *   - Auth via ACL — only single-password AUTH on connect.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions as TlsOptions } from 'node:tls';
import type { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';

export interface RedisMiniClientOptions {
  host: string;
  port?: number;
  /** Optional AUTH password sent immediately after connect. */
  password?: string;
  /** Optional select-db sent after AUTH. */
  db?: number;
  /** How long a single command may wait for a reply (ms). */
  commandTimeoutMs?: number;
  /** Max bytes buffered in flight before we apply backpressure. */
  socketHighWaterMark?: number;
  /**
   * Enable TLS (in-transit encryption — required for AWS ElastiCache
   * for Redis with the `transit_encryption_enabled` setting).
   * - `true`        → use TLS with default options (verify the cert).
   * - `TlsOptions`  → caller-supplied TLS options (CA bundle, ALPN,
   *                   servername override, rejectUnauthorized, etc.).
   * Default: undefined (plain TCP).
   */
  tls?: boolean | TlsOptions;
  /**
   * Override the dial function. Test harnesses use this to substitute
   * an in-process Duplex stream. Production should leave it unset.
   */
  dial?: (host: string, port: number) => Duplex;
}

interface InFlight {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT = 5_000;

export class RedisMiniClient {
  private readonly log = new Logger(RedisMiniClient.name);
  private socket: Duplex | null = null;
  private connecting: Promise<void> | null = null;
  private readonly inFlight: InFlight[] = [];
  private readbuf: Buffer = Buffer.alloc(0);

  constructor(private readonly opts: RedisMiniClientOptions) {
    if (!opts.host) throw new Error('RedisMiniClient: host is required');
  }

  // -------------------------------------------------------------------------
  // Public surface (RedisLike)
  // -------------------------------------------------------------------------

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.command('EVAL', script, String(numKeys), ...args.map(String));
  }

  /** Issued at the end of process lifecycle; idempotent. */
  async quit(): Promise<void> {
    if (!this.socket) return;
    try {
      await this.command('QUIT');
    } catch {
      /* socket may already be closed; ignore */
    }
    this.socket?.destroy();
    this.socket = null;
  }

  // -------------------------------------------------------------------------
  // Wire protocol
  // -------------------------------------------------------------------------

  private async command(...parts: string[]): Promise<unknown> {
    await this.ensureConnected();
    const sock = this.socket!;
    const payload = encodeArray(parts);
    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        // Failure isolates this command; the socket may stay alive.
        const idx = this.inFlight.findIndex((x) => x.timeoutHandle === timeoutHandle);
        if (idx >= 0) this.inFlight.splice(idx, 1);
        reject(new Error(`redis ${parts[0]} timed out after ${this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT}ms`));
      }, this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT);
      this.inFlight.push({ resolve, reject, timeoutHandle });
      sock.write(payload);
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<void> {
    this.readbuf = Buffer.alloc(0);
    const port = this.opts.port ?? 6379;
    const sock = this.dialSocket(this.opts.host, port);
    // setNoDelay only exists on net.Socket / tls.TLSSocket; both extend
    // Duplex but not all Duplex have it. Best-effort.
    const sockTcp = sock as Socket;
    if (typeof sockTcp.setNoDelay === 'function') {
      try { sockTcp.setNoDelay(true); } catch { /* */ }
    }
    this.socket = sock;
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', (err: Error) => this.onSocketError(err));
    sock.on('close', () => this.onSocketClose());

    // Wait for the underlying transport to be ready. For plain TCP that's
    // 'connect'; for TLS we want 'secureConnect' but the `tls.connect` call
    // also fires 'connect'. We listen to whichever fires first + treat
    // 'error' as fatal.
    const readyEvent = this.opts.tls ? 'secureConnect' : 'connect';
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        sock.off('error', onErr);
        resolve();
      };
      const onErr = (err: Error) => {
        sock.off(readyEvent, onReady);
        reject(err);
      };
      sock.once(readyEvent, onReady);
      sock.once('error', onErr);
    });

    if (this.opts.password) {
      const r = await this.command('AUTH', this.opts.password);
      if (r !== 'OK') throw new Error(`redis AUTH failed: ${String(r)}`);
    }
    if (typeof this.opts.db === 'number') {
      await this.command('SELECT', String(this.opts.db));
    }
    const scheme = this.opts.tls ? 'rediss' : 'redis';
    this.log.log(`connected to ${scheme}://${this.opts.host}:${port}`);
  }

  /** Build the socket. Test harnesses can supply `dial` to swap in a Duplex. */
  private dialSocket(host: string, port: number): Duplex {
    if (this.opts.dial) {
      return this.opts.dial(host, port);
    }
    if (this.opts.tls) {
      const tlsOpts: TlsOptions = typeof this.opts.tls === 'boolean' ? {} : this.opts.tls;
      // Default: verify the cert (rejectUnauthorized=true). Caller can
      // disable for self-signed dev environments via TlsOptions.
      return tlsConnect({
        host,
        port,
        servername: host, // SNI for shared-host Redis services
        ...tlsOpts,
      });
    }
    return netConnect({ host, port });
  }

  private onSocketError(err: Error): void {
    this.log.warn(`redis socket error: ${err.message}`);
    this.failInFlight(err);
  }

  private onSocketClose(): void {
    this.failInFlight(new Error('redis socket closed'));
    this.socket = null;
  }

  private failInFlight(err: Error): void {
    while (this.inFlight.length) {
      const f = this.inFlight.shift()!;
      clearTimeout(f.timeoutHandle);
      f.reject(err);
    }
  }

  private onData(chunk: Buffer): void {
    this.readbuf = Buffer.concat([this.readbuf, chunk]);
    while (true) {
      const r = parseOne(this.readbuf, 0);
      if (!r) break;
      const [value, consumed] = r;
      this.readbuf = this.readbuf.subarray(consumed);
      const f = this.inFlight.shift();
      if (!f) {
        this.log.warn('redis reply with no in-flight request');
        continue;
      }
      clearTimeout(f.timeoutHandle);
      if (value instanceof Error) f.reject(value);
      else f.resolve(value);
    }
  }
}

// ---------------------------------------------------------------------------
// RESP-2 encoder + parser. Exported for unit tests.
// ---------------------------------------------------------------------------

export function encodeArray(parts: string[]): Buffer {
  let out = `*${parts.length}\r\n`;
  for (const p of parts) {
    const buf = Buffer.from(p, 'utf8');
    out += `$${buf.length}\r\n${buf.toString('utf8')}\r\n`;
  }
  return Buffer.from(out, 'utf8');
}

/**
 * Parse one RESP-2 value starting at offset. Returns [value, consumed]
 * or null if more bytes are needed. Errors are returned as `Error`
 * values (since RESP supports `-ERROR`). Native bulk-strings come back
 * as `string`; native arrays as `unknown[]`; integers as `number`; nil
 * as `null`.
 */
export function parseOne(buf: Buffer, off: number): [unknown, number] | null {
  if (off >= buf.length) return null;
  const type = String.fromCharCode(buf[off]);
  const lineEnd = buf.indexOf('\r\n', off + 1);
  if (lineEnd < 0) return null;
  const head = buf.slice(off + 1, lineEnd).toString('utf8');
  const afterLine = lineEnd + 2;

  switch (type) {
    case '+':
      return [head, afterLine];
    case '-':
      return [new Error(head), afterLine];
    case ':':
      return [Number(head), afterLine];
    case '$': {
      const len = Number(head);
      if (len === -1) return [null, afterLine];
      if (afterLine + len + 2 > buf.length) return null;
      const value = buf.slice(afterLine, afterLine + len).toString('utf8');
      return [value, afterLine + len + 2];
    }
    case '*': {
      const count = Number(head);
      if (count === -1) return [null, afterLine];
      const items: unknown[] = [];
      let cur = afterLine;
      for (let i = 0; i < count; i++) {
        const r = parseOne(buf, cur);
        if (!r) return null;
        items.push(r[0]);
        cur = r[1];
      }
      return [items, cur];
    }
    default:
      throw new Error(`RESP: unknown type prefix ${type}`);
  }
}
