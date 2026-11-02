/**
 * The SFTP channel (0120): how batch files travel to and from Availity,
 * Waystar, TriZetto and Inovalon — the one transport all four document.
 *
 * Server only (ssh2, serverExternalPackages in next.config.ts).
 *
 * THE HOST KEY IS PINNED. The first successful test of a connection records
 * the server's host key (SHA-256); every connection after that refuses a
 * server presenting a different one. Without that, anyone able to answer for
 * the host name receives the practice's claims — every patient's name, birth
 * date and member ID — and its SFTP password.
 *
 * Connects to the address endpoint-guard.ts resolved and checked, never to a
 * second lookup of the name.
 */
import { createHash } from "node:crypto";

import { Client, type SFTPWrapper } from "ssh2";

import { ValidationError } from "@/lib/api";

import { resolvePublicHost } from "../endpoint-guard";

export interface SftpTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** The pinned host key; null before the first test. */
  hostKeySha256: string | null;
}

export interface RemoteFile {
  name: string;
  size: number;
  modifiedAt: Date;
}

export interface SftpSession {
  /** The host key the server presented (to pin on a first test). */
  hostKeySha256: string;
  list(dir: string): Promise<RemoteFile[]>;
  get(dir: string, name: string): Promise<Buffer>;
  put(dir: string, name: string, data: Buffer): Promise<void>;
  close(): void;
}

export class SftpError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "SftpError";
  }
}

export const hostKeyFingerprint = (key: Buffer) => createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

const join = (dir: string, name: string) => (dir === "" || dir === "." ? name : `${dir.replace(/\/+$/, "")}/${name}`);

/** Why ssh2 failed, in words a practice admin can act on. Never the password. */
function explain(err: unknown, host: string): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/Host denied|verification failed/i.test(m)) {
    return `${host} presented a different host key from the one recorded when this connection was first tested. Nothing was sent. If the clearinghouse changed its key, reset the recorded key on the connection and test again.`;
  }
  if (/authentication/i.test(m)) return `${host} refused the SFTP user or password.`;
  if (/ECONNREFUSED/.test(m)) return `${host} refused the connection on that port.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `${host} could not be found.`;
  if (/timed? ?out|ETIMEDOUT/i.test(m)) return `${host} did not answer in time.`;
  if (/No such file/i.test(m)) return `A folder or file named on the connection does not exist on ${host}.`;
  if (/Permission denied/i.test(m)) return `The SFTP user may not do that on ${host} (permission denied).`;
  return `SFTP to ${host} failed: ${m.slice(0, 200)}`;
}

export async function openSftp(target: SftpTarget, opts: { timeoutMs?: number } = {}): Promise<SftpSession> {
  const address = await resolvePublicHost(target.host);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const client = new Client();
  let presented = "";
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end();
      reject(new SftpError(`${target.host} did not answer in time.`));
    }, timeoutMs + 2_000);
    client
      .on("ready", () => {
        client.sftp((err, s) => {
          clearTimeout(timer);
          if (err) {
            client.end();
            reject(new SftpError(explain(err, target.host)));
          } else resolve(s);
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(new SftpError(explain(err, target.host)));
      })
      .connect({
        host: address,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKey: target.privateKey,
        passphrase: target.passphrase,
        readyTimeout: timeoutMs,
        // The pin: a key other than the recorded one ends the handshake
        // before the password is sent.
        hostVerifier: (key: Buffer) => {
          presented = hostKeyFingerprint(key);
          return target.hostKeySha256 === null || target.hostKeySha256 === presented;
        },
      });
  });

  const op = <T>(fn: (done: (err: Error | undefined | null, v?: T) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SftpError(`${target.host} stopped answering.`)), timeoutMs);
      fn((err, v) => {
        clearTimeout(timer);
        if (err) reject(new SftpError(explain(err, target.host)));
        else resolve(v as T);
      });
    });

  return {
    hostKeySha256: presented,
    list: (dir) =>
      op<RemoteFile[]>((done) =>
        sftp.readdir(dir === "" ? "." : dir, (err, list) =>
          done(
            err,
            (list ?? [])
              .filter((e) => e.attrs.isFile())
              .map((e) => ({ name: e.filename, size: Number(e.attrs.size), modifiedAt: new Date(Number(e.attrs.mtime) * 1000) })),
          ),
        ),
      ),
    get: (dir, name) => op<Buffer>((done) => sftp.readFile(join(dir, name), (err, buf) => done(err, buf))),
    put: (dir, name, data) => op<void>((done) => sftp.writeFile(join(dir, name), data, (err) => done(err ?? null))),
    close: () => client.end(),
  };
}
