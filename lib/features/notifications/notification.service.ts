/**
 * Notification service — per-user in-app inbox (Phase F).
 *
 * Messaging @mentions write rows into `notification` (migration 0046);
 * this service reads them for the sidebar bell badge + dropdown, and
 * marks them read. RLS-scoped via withOrgContext.
 *
 * Each row is read back with a sentence and a link (Level-1 doc:57): the
 * rows were written from the start and nothing showed them. The sentence
 * names who and which patient, never the message itself, so the bell holds
 * no clinical text.
 */
import { withOrgContext } from "@/lib/db";
import { ESCALATION_MEASURE_INFO, type EscalationMeasure } from "@/lib/features/care-plans/care-plan.types";

export interface NotificationView {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  /** What happened, e.g. "Marcus Delgado mentioned you about Ruth Alvarez". */
  title: string;
  /** Where to act on it, or null when there is nowhere to go. */
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

/**
 * A notification's sentence and link. `names` resolves the people and
 * patients a payload refers to by id. A kind this does not know reads its
 * own `title`/`href` from the payload, so a new source needs no change here.
 */
export function describeNotification(
  kind: string,
  payload: Record<string, unknown>,
  names: { patients: Map<string, string>; authors: Map<string, string>; users?: Map<string, string> },
): { title: string; href: string | null } {
  if (kind === "patient_thread_mention") {
    const patientId = uuid(payload.patientId);
    const author = (uuid(payload.messageId) && names.authors.get(payload.messageId as string)) || "A colleague";
    const patient = patientId ? names.patients.get(patientId) : undefined;
    return {
      title: patient ? `${author} mentioned you about ${patient}` : `${author} mentioned you in a patient's messages`,
      href: patientId ? `/patients/${patientId}?tab=messages` : null,
    };
  }
  // An escalation (0116): which measure, a closed set, never the reading.
  if (kind === "escalation_alert") {
    const patientId = uuid(payload.patientId);
    const patient = patientId ? names.patients.get(patientId) : undefined;
    const m = str(payload.measure) && ESCALATION_MEASURE_INFO[payload.measure as EscalationMeasure];
    const what = m
      ? m.crosses === "any"
        ? `${m.label} was recorded`
        : `${m.label} crossed the care plan's limit`
      : "An escalation criterion was met";
    return {
      title: patient ? `${what} for ${patient}` : what,
      href: patientId ? `/patients/${patientId}` : "/inbox",
    };
  }
  // A task given to this person (0116): who gave it and about whom, never its words.
  if (kind === "care_task_assigned") {
    const patientId = uuid(payload.patientId);
    const patient = patientId ? names.patients.get(patientId) : undefined;
    const by = (uuid(payload.byUserId) && names.users?.get(payload.byUserId as string)) || "A colleague";
    return {
      title: patient ? `${by} gave you a task about ${patient}` : `${by} gave you a task`,
      href: patientId ? `/patients/${patientId}?tab=tasks` : "/tasks",
    };
  }
  const href = str(payload.href);
  return {
    title: str(payload.title) ?? kind.replace(/_/g, " "),
    // Only a path inside the app: a payload is data, not a place to send people.
    href: href && href.startsWith("/") && !href.startsWith("//") ? href : null,
  };
}

export async function listNotifications(args: {
  orgId: string;
  userId: string;
  unreadOnly?: boolean;
  limit?: number;
}): Promise<{ notifications: NotificationView[]; unreadCount: number }> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 30));
  return withOrgContext(args.orgId, async (tx) => {
    const rows = args.unreadOnly
      ? await tx.$queryRaw<Row[]>`
          SELECT id, kind, payload, read_at, created_at
            FROM notification
           WHERE user_id = ${args.userId}::uuid AND read_at IS NULL
           ORDER BY created_at DESC LIMIT ${limit}
        `
      : await tx.$queryRaw<Row[]>`
          SELECT id, kind, payload, read_at, created_at
            FROM notification
           WHERE user_id = ${args.userId}::uuid
           ORDER BY created_at DESC LIMIT ${limit}
        `;
    const counts = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM notification
       WHERE user_id = ${args.userId}::uuid AND read_at IS NULL
    `;

    // The names the sentences need, two reads for the whole page. Both are
    // this org's rows (RLS, and the org named).
    const patientIds = [...new Set(rows.map((r) => uuid(r.payload?.patientId)).filter((v): v is string => !!v))];
    const messageIds = [...new Set(rows.map((r) => uuid(r.payload?.messageId)).filter((v): v is string => !!v))];
    const userIds = [...new Set(rows.map((r) => uuid(r.payload?.byUserId)).filter((v): v is string => !!v))];
    const patients = new Map<string, string>();
    const authors = new Map<string, string>();
    const users = new Map<string, string>();
    if (patientIds.length > 0) {
      const ps = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id::text AS id, TRIM(first_name || ' ' || last_name) AS name
          FROM patient
         WHERE org_id = ${args.orgId}::uuid AND id = ANY(${patientIds}::uuid[])
      `;
      for (const p of ps) patients.set(p.id, p.name);
    }
    if (messageIds.length > 0) {
      const ms = await tx.$queryRaw<{ id: string; name: string | null }[]>`
        SELECT pm.id::text AS id, COALESCE(u.full_name, u.email) AS name
          FROM patient_message pm
          LEFT JOIN app_user u ON u.id = pm.author_user_id
         WHERE pm.org_id = ${args.orgId}::uuid AND pm.id = ANY(${messageIds}::uuid[])
      `;
      for (const m of ms) if (m.name) authors.set(m.id, m.name);
    }
    if (userIds.length > 0) {
      // Members of this org only: a payload is data, and names nobody else.
      const us = await tx.$queryRaw<{ id: string; name: string | null }[]>`
        SELECT u.id::text AS id, COALESCE(u.full_name, u.email) AS name
          FROM app_user u
          JOIN org_member om ON om.user_id = u.id AND om.org_id = ${args.orgId}::uuid
         WHERE u.id = ANY(${userIds}::uuid[])
      `;
      for (const u of us) if (u.name) users.set(u.id, u.name);
    }

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        payload: r.payload,
        ...describeNotification(r.kind, r.payload ?? {}, { patients, authors, users }),
        readAt: r.read_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      unreadCount: Number(counts[0]?.n ?? 0),
    };
  });
}

/** Mark one or all of the caller's notifications read. */
export async function markNotificationsRead(args: {
  orgId: string;
  userId: string;
  id?: string;
}): Promise<{ updated: number }> {
  return withOrgContext(args.orgId, async (tx) => {
    const n = args.id
      ? await tx.$executeRaw`
          UPDATE notification SET read_at = now()
           WHERE user_id = ${args.userId}::uuid AND id = ${args.id}::uuid AND read_at IS NULL
        `
      : await tx.$executeRaw`
          UPDATE notification SET read_at = now()
           WHERE user_id = ${args.userId}::uuid AND read_at IS NULL
        `;
    return { updated: n };
  });
}
