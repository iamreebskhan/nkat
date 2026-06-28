/**
 * Notification service — per-user in-app inbox (Phase F).
 *
 * Messaging @mentions write rows into `notification` (migration 0046);
 * this service reads them for the sidebar bell badge + dropdown, and
 * marks them read. RLS-scoped via withOrgContext.
 */
import { withOrgContext } from "@/lib/db";

export interface NotificationView {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
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
    return {
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        payload: r.payload,
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
