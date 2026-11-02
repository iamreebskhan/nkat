/**
 * Checking a clearinghouse for responses (0120): list the connection's
 * download folders over SFTP, read every file not read before, and apply it
 * (inbound.service.ts). Run by a person ("Check for responses now") or by the
 * cron route for every active SFTP connection.
 *
 * Files are left where they are: Availity archives its ReceiveFiles after 30
 * days itself, and a file deleted by Pallio could not be fetched again by the
 * practice's billing staff. A file already read is skipped by its name and
 * size before it is downloaded, and by its content hash if it is.
 *
 * Availity also writes a "-success"/"-FAILED" notice for each file into the
 * upload folder (SendFiles); for a vendor that does, the upload folder is
 * read too, for notices about Pallio's own files only.
 */
import { withBreakglass, withOrgContext } from "@/lib/db";
import { reportError } from "@/lib/observability/sentry";

import { loadConnection } from "./connection.service";
import { ingestClearinghouseFile, type FileReport } from "./inbound.service";
import { openSftp } from "./transport/sftp";

const MAX_FILES = 200;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface PollReport {
  connectionId: string;
  ok: boolean;
  message: string;
  files: { name: string; folder: string; kind: string; outcome: string; note: string }[];
  skipped: number;
}

export async function pollConnection(args: { orgId: string; connectionId: string; userId: string | null }): Promise<PollReport> {
  const conn = await withOrgContext(args.orgId, (tx) => loadConnection(tx, args.orgId, args.connectionId));
  const report: PollReport = { connectionId: conn.id, ok: true, message: "", files: [], skipped: 0 };
  if (conn.status !== "active" || conn.batchChannel !== "sftp" || !conn.settings.sftp) {
    return { ...report, ok: false, message: "This connection has no active SFTP channel to check." };
  }
  const s = conn.settings.sftp;
  let bytes = 0;
  try {
    const session = await openSftp({
      host: s.host, port: s.port, username: s.username, password: conn.secrets.sftpPassword,
      privateKey: conn.secrets.sftpPrivateKey, passphrase: conn.secrets.sftpPassphrase, hostKeySha256: conn.hostKeySha256,
    });
    try {
      const folders = [...s.downloadDirs.map((d) => ({ dir: d, notices: false }))];
      if (s.notificationsInUploadDir) folders.push({ dir: s.uploadDir, notices: true });
      for (const f of folders) {
        const listed = await session.list(f.dir);
        const candidates = listed
          .filter((x) => (f.notices ? /^pallio-837p-\d{9}.*-(success|failed)$/i.test(x.name) : true))
          .sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime() || a.name.localeCompare(b.name));
        const seen = await withOrgContext(args.orgId, (tx) => tx.$queryRaw<{ remote_name: string; remote_size: bigint | null }[]>`
          SELECT remote_name, remote_size FROM clearinghouse_file
           WHERE org_id = ${args.orgId}::uuid AND connection_id = ${conn.id}::uuid
             AND remote_name = ANY(${candidates.map((c) => c.name)}::text[])
        `);
        const seenKey = new Set(seen.map((r) => `${r.remote_name}|${r.remote_size ?? ""}`));
        for (const file of candidates) {
          if (seenKey.has(`${file.name}|${file.size}`)) {
            report.skipped += 1;
            continue;
          }
          if (report.files.length >= MAX_FILES || bytes + file.size > MAX_BYTES) {
            report.message = `Read ${report.files.length} files; the rest are read on the next check.`;
            break;
          }
          if (file.size > MAX_FILE_BYTES) {
            report.files.push({ name: file.name, folder: f.dir, kind: "unknown", outcome: "failed", note: "Over 10 MB; download it from the clearinghouse and upload it in parts." });
            continue;
          }
          const buf = await session.get(f.dir, file.name);
          bytes += buf.length;
          let r: FileReport;
          try {
            r = await ingestClearinghouseFile({
              orgId: args.orgId, userId: args.userId, connectionId: conn.id, source: "sftp",
              name: file.name, text: buf.toString("utf8"), remoteSize: file.size,
            });
          } catch (err) {
            reportError(err, { source: "pollConnection" });
            report.files.push({ name: file.name, folder: f.dir, kind: "unknown", outcome: "failed", note: "This file could not be read; the next check tries it again." });
            continue;
          }
          report.files.push({ name: file.name, folder: f.dir, kind: r.kind, outcome: r.outcome, note: r.note });
        }
      }
    } finally {
      session.close();
    }
    if (!report.message) {
      report.message = report.files.length === 0
        ? `No new files (${report.skipped} already read).`
        : `Read ${report.files.length} new file${report.files.length === 1 ? "" : "s"}${report.skipped ? ` (${report.skipped} already read)` : ""}.`;
    }
  } catch (err) {
    report.ok = false;
    report.message = err instanceof Error ? err.message : "The check failed.";
  }
  await withOrgContext(args.orgId, (tx) => tx.$executeRaw`
    UPDATE clearinghouse_connection SET last_poll_at = now(), last_poll_ok = ${report.ok}, last_poll_message = ${report.message.slice(0, 500)}
     WHERE org_id = ${args.orgId}::uuid AND id = ${conn.id}::uuid
  `);
  return report;
}

/** The cron: every active SFTP connection in every org, one after another. */
export async function pollAllConnections(): Promise<{ connections: number; files: number; failed: number }> {
  const targets = await withBreakglass(
    (db) => db.$queryRaw<{ org_id: string; id: string }[]>`
      SELECT org_id, id FROM clearinghouse_connection WHERE status = 'active' AND batch_channel = 'sftp'
    `,
    "cron: clearinghouse response poll (list active SFTP connections across orgs)",
  );
  let files = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      const r = await pollConnection({ orgId: t.org_id, connectionId: t.id, userId: null });
      files += r.files.length;
      if (!r.ok) failed += 1;
    } catch (err) {
      failed += 1;
      reportError(err, { source: "pollAllConnections" });
    }
  }
  return { connections: targets.length, files, failed };
}
