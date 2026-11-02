/**
 * Patient-scoped messaging — Phase F (nurses-only v1).
 *
 * Per Mark's 2026-05-22 input. Threads are auto-created on first post.
 * Messages are immutable after a 5-minute edit window. @mention parsing
 * happens at write-time so notification fan-out doesn't re-scan body
 * text on every read.
 *
 * RLS: tenant-scoped via withOrgContext. PHI access: every list/get
 * writes an audit_log row (handled by the route).
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

import { findMentions, type Mentionable } from "./mentions";

const EDIT_WINDOW_MS = 5 * 60 * 1000;

export interface MessageView {
  id: string;
  threadId: string;
  authorUserId: string;
  /**
   * The author's name (email when they have none). The panel printed the
   * first 8 characters of their user id.
   */
  authorName: string | null;
  body: string;
  mentionedUserIds: string[];
  readBy: string[];
  editedAt: string | null;
  createdAt: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  author_user_id: string;
  author_name: string | null;
  body: string;
  mentioned_user_ids: string[];
  read_by: string[];
  edited_at: Date | null;
  created_at: Date;
}

function rowToView(r: MessageRow): MessageView {
  return {
    id: r.id,
    threadId: r.thread_id,
    authorUserId: r.author_user_id,
    authorName: r.author_name,
    body: r.body,
    mentionedUserIds: r.mentioned_user_ids,
    readBy: r.read_by,
    editedAt: r.edited_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * The org's active members, who a message can mention: what the composer
 * suggests and what a mention is matched against.
 */
export async function listMentionable(orgId: string): Promise<Mentionable[]> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; full_name: string | null; email: string }[]>`
      SELECT u.id, u.full_name, u.email
        FROM app_user u
        JOIN org_member m ON m.user_id = u.id
       WHERE m.org_id = ${orgId}::uuid
         AND m.status = 'active'
       ORDER BY lower(COALESCE(u.full_name, u.email))
    `;
    return rows.map((r) => ({ userId: r.id, fullName: r.full_name, email: r.email }));
  });
}

/**
 * Resolve @mentions in the body to user_ids: a member's full name, email, or
 * a first name only one member has (mentions.ts). Unknown @mentions are
 * silently ignored (no PII leak about who is on the team).
 */
async function resolveMentions(args: {
  orgId: string;
  body: string;
}): Promise<string[]> {
  if (!args.body.includes("@")) return [];
  return findMentions(args.body, await listMentionable(args.orgId));
}

async function ensureThread(args: {
  orgId: string;
  patientId: string;
  userId: string;
}): Promise<string> {
  return withOrgContext(args.orgId, async (tx) => {
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient_thread
       WHERE org_id = ${args.orgId}::uuid AND patient_id = ${args.patientId}::uuid
       LIMIT 1
    `;
    if (existing[0]) return existing[0].id;
    const ins = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_thread (org_id, patient_id, created_by)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    return ins[0]!.id;
  });
}

export async function listMessages(args: {
  orgId: string;
  patientId: string;
  userId: string;
  limit?: number;
}): Promise<{ messages: MessageView[]; threadId: string | null }> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 100));
  return withOrgContext(args.orgId, async (tx) => {
    const t = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient_thread
       WHERE org_id = ${args.orgId}::uuid AND patient_id = ${args.patientId}::uuid
       LIMIT 1
    `;
    if (!t[0]) return { messages: [], threadId: null };
    const threadId = t[0].id;
    const rows = await tx.$queryRaw<MessageRow[]>`
      SELECT pm.id, pm.thread_id, pm.author_user_id,
             COALESCE(u.full_name, u.email) AS author_name,
             pm.body, pm.mentioned_user_ids, pm.read_by, pm.edited_at, pm.created_at
        FROM patient_message pm
        LEFT JOIN app_user u ON u.id = pm.author_user_id
       WHERE pm.thread_id = ${threadId}::uuid
       ORDER BY pm.created_at ASC
       LIMIT ${limit}
    `;
    // Mark each as read by the caller (idempotent).
    await tx.$executeRaw`
      UPDATE patient_message
         SET read_by = ARRAY(SELECT DISTINCT unnest(read_by || ${args.userId}::uuid))
       WHERE thread_id = ${threadId}::uuid
         AND NOT (${args.userId}::uuid = ANY(read_by))
    `;
    return { messages: rows.map(rowToView), threadId };
  });
}

export async function postMessage(args: {
  orgId: string;
  patientId: string;
  userId: string;
  body: string;
}): Promise<MessageView> {
  if (args.body.trim().length === 0) throw new ValidationError("Empty message.");
  if (args.body.length > 5000) throw new ValidationError("Message too long.");

  const threadId = await ensureThread(args);
  const mentions = await resolveMentions({ orgId: args.orgId, body: args.body });

  const inserted = await withOrgContext(args.orgId, async (tx) => {
    const ins = await tx.$queryRaw<MessageRow[]>`
      INSERT INTO patient_message (
        org_id, thread_id, author_user_id, body, mentioned_user_ids, read_by
      ) VALUES (
        ${args.orgId}::uuid, ${threadId}::uuid, ${args.userId}::uuid,
        ${args.body}, ${mentions}::uuid[], ARRAY[${args.userId}::uuid]::uuid[]
      )
      RETURNING id, thread_id, author_user_id,
                (SELECT COALESCE(full_name, email) FROM app_user WHERE id = author_user_id) AS author_name,
                body, mentioned_user_ids, read_by, edited_at, created_at
    `;
    await tx.$executeRaw`
      UPDATE patient_thread SET last_message_at = now()
       WHERE id = ${threadId}::uuid
    `;
    // Fan-out notifications for @mentions (best-effort; ignore errors).
    if (mentions.length > 0) {
      for (const m of mentions) {
        if (m === args.userId) continue;
        await tx.$executeRaw`
          INSERT INTO notification (org_id, user_id, kind, payload)
          VALUES (
            ${args.orgId}::uuid, ${m}::uuid, 'patient_thread_mention',
            ${JSON.stringify({ patientId: args.patientId, threadId, messageId: ins[0]!.id })}::jsonb
          )
        `.catch(() => 0);
      }
    }
    return ins[0]!;
  });
  return rowToView(inserted);
}

export async function editMessage(args: {
  orgId: string;
  id: string;
  userId: string;
  newBody: string;
}): Promise<{ updated: boolean }> {
  if (args.newBody.trim().length === 0) throw new ValidationError("Empty message.");
  if (args.newBody.length > 5000) throw new ValidationError("Message too long.");
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { author_user_id: string; created_at: Date; body: string }[]
    >`
      SELECT author_user_id, created_at, body FROM patient_message
       WHERE id = ${args.id}::uuid
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) throw new NotFoundError("Message not found.");
    if (r.author_user_id !== args.userId) throw new ValidationError("Only the author can edit.");
    const ageMs = Date.now() - r.created_at.getTime();
    if (ageMs > EDIT_WINDOW_MS) {
      throw new ValidationError("Edit window (5 minutes) has expired.");
    }
    const updated = await tx.$executeRaw`
      UPDATE patient_message
         SET body = ${args.newBody},
             edited_at = now(),
             edit_history = edit_history || ${JSON.stringify([{ at: new Date().toISOString(), body: r.body }])}::jsonb
       WHERE id = ${args.id}::uuid
    `;
    return { updated: updated > 0 };
  });
}
