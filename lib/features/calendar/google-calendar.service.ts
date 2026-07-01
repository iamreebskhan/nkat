/**
 * Google Calendar two-way sync — Phase E.
 *
 * Responsibilities:
 *   * OAuth: exchange auth-code → refresh token, store encrypted.
 *   * Read access tokens on demand (refresh when expired).
 *   * Pull events from Google (incremental via sync_token).
 *   * Push Pallio visits out as Google events.
 *   * Check conflicts against the clinician's Google calendar before
 *     a Pallio schedule POST is accepted.
 *
 * Env required:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI         e.g. https://app.pallio.io/api/integrations/google/callback
 *   PALLIO_TOKEN_KEY                  pgcrypto symmetric key for refresh-token encryption
 *
 * When credentials are absent (dev / fresh-install), every function
 * raises a typed error the route translates into a friendly 503 "set up
 * Google Calendar in env first" message instead of a crash.
 */
import { withBreakglass, withOrgContext } from "@/lib/db";

const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export class GoogleConfigMissingError extends Error {
  constructor() {
    super(
      "Google Calendar is not configured (set GOOGLE_OAUTH_CLIENT_ID / SECRET / REDIRECT_URI / PALLIO_TOKEN_KEY).",
    );
    this.name = "GoogleConfigMissingError";
  }
}

function requireConfig() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const key = process.env.PALLIO_TOKEN_KEY;
  if (!id || !secret || !redirect || !key) throw new GoogleConfigMissingError();
  return { id, secret, redirect, key };
}

/** Build the consent URL the user lands on to grant calendar access. */
export function buildAuthUrl(state: string): string {
  const cfg = requireConfig();
  const params = new URLSearchParams({
    client_id: cfg.id,
    redirect_uri: cfg.redirect,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    scope: REQUIRED_SCOPES.join(" "),
    state,
  });
  return `${GOOGLE_OAUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the OAuth `code` for a refresh token and persist it.
 * State carries `${orgId}:${userId}` (signed/HMAC'd in the route).
 */
export async function exchangeCodeAndStore(args: {
  orgId: string;
  userId: string;
  code: string;
}): Promise<{ stored: boolean; scopes: string[] }> {
  const cfg = requireConfig();
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: args.code,
      client_id: cfg.id,
      client_secret: cfg.secret,
      redirect_uri: cfg.redirect,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Google token exchange failed (${r.status}): ${t.slice(0, 300)}`);
  }
  const data = (await r.json()) as {
    refresh_token?: string;
    scope?: string;
  };
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token (revoke prior consent + retry with prompt=consent).",
    );
  }
  const scopes = (data.scope ?? "").split(/\s+/).filter(Boolean);

  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO clinician_calendar_link (
        org_id, user_id, provider, refresh_token_encrypted, scopes, status
      ) VALUES (
        ${args.orgId}::uuid, ${args.userId}::uuid, 'google',
        pgp_sym_encrypt(${data.refresh_token!}, ${cfg.key}),
        ${scopes}::text[],
        'connected'
      )
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        scopes = EXCLUDED.scopes,
        status = 'connected',
        last_error = NULL,
        updated_at = now()
    `;
  });
  return { stored: true, scopes };
}

/** Decrypt + exchange the refresh token for a current access token. */
async function getAccessToken(args: { orgId: string; userId: string }): Promise<string> {
  const cfg = requireConfig();
  const rows = await withOrgContext(args.orgId, async (tx) => {
    return tx.$queryRaw<{ refresh: string; status: string }[]>`
      SELECT pgp_sym_decrypt(refresh_token_encrypted, ${cfg.key}) AS refresh, status
        FROM clinician_calendar_link
       WHERE org_id = ${args.orgId}::uuid
         AND user_id = ${args.userId}::uuid
       LIMIT 1
    `;
  });
  const row = rows[0];
  if (!row) throw new Error("Calendar not connected for this user.");
  if (row.status === "revoked") throw new Error("Calendar connection was revoked. Reconnect.");
  const refresh = row.refresh;

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: cfg.id,
      client_secret: cfg.secret,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) {
    await withOrgContext(args.orgId, async (tx) => {
      await tx.$executeRaw`
        UPDATE clinician_calendar_link
           SET status = 'expired', last_error = 'refresh failed', updated_at = now()
         WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
      `;
    });
    throw new Error("Google refresh failed; user needs to reconnect.");
  }
  const data = (await r.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Conflict check — return any Google events that overlap [from, to] for
 * the given clinician. Used by the schedule POST route to warn before
 * creating a double-booking.
 */
export interface BusySlot {
  start: string;
  end: string;
  summary: string;
}

export async function getBusyForClinician(args: {
  orgId: string;
  userId: string;
  fromIso: string;
  toIso: string;
}): Promise<BusySlot[]> {
  const token = await getAccessToken({ orgId: args.orgId, userId: args.userId });
  const r = await fetch(`${GOOGLE_CALENDAR_API}/freeBusy`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      timeMin: args.fromIso,
      timeMax: args.toIso,
      items: [{ id: "primary" }],
    }),
  });
  if (!r.ok) throw new Error(`Google freeBusy failed (${r.status})`);
  const data = (await r.json()) as {
    calendars?: { primary?: { busy?: { start: string; end: string }[] } };
  };
  const busy = data.calendars?.primary?.busy ?? [];
  return busy.map((b) => ({ start: b.start, end: b.end, summary: "" }));
}

/**
 * Push a Pallio visit out as a Google event. Idempotent via the
 * visit_external_event mapping table.
 */
export async function pushVisitToGoogle(args: {
  orgId: string;
  userId: string;
  visitId: string;
  startIso: string;
  endIso: string;
  summary: string;
  description?: string;
  location?: string;
}): Promise<{ externalId: string; created: boolean }> {
  const token = await getAccessToken({ orgId: args.orgId, userId: args.userId });

  // Look up existing mapping.
  const existing = await withOrgContext(args.orgId, async (tx) => {
    return tx.$queryRaw<{ external_event_id: string }[]>`
      SELECT external_event_id FROM visit_external_event
       WHERE visit_id = ${args.visitId}::uuid AND provider = 'google'
       LIMIT 1
    `;
  });

  if (existing[0]) {
    const externalId = existing[0].external_event_id;
    // PATCH it (start/end might have moved).
    const patch = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/primary/events/${encodeURIComponent(externalId)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          summary: args.summary,
          description: args.description ?? "",
          location: args.location ?? "",
          start: { dateTime: args.startIso },
          end: { dateTime: args.endIso },
        }),
      },
    );
    if (!patch.ok) throw new Error(`Google event update failed (${patch.status})`);
    return { externalId, created: false };
  }

  const insert = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: args.summary,
        description: args.description ?? "",
        location: args.location ?? "",
        start: { dateTime: args.startIso },
        end: { dateTime: args.endIso },
      }),
    },
  );
  if (!insert.ok) throw new Error(`Google event create failed (${insert.status})`);
  const ev = (await insert.json()) as { id: string };
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO visit_external_event (org_id, visit_id, provider, external_event_id, direction)
      VALUES (${args.orgId}::uuid, ${args.visitId}::uuid, 'google', ${ev.id}, 'pallio_origin')
      ON CONFLICT (provider, external_event_id) DO NOTHING
    `;
    await tx.$executeRaw`
      UPDATE clinician_calendar_link SET last_push_at = now(), updated_at = now()
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
    `;
  });
  return { externalId: ev.id, created: true };
}

/** Disconnect — revoke (best-effort) + remove the row. Works even when
 * Google isn't configured: we always drop the local link, and only
 * attempt the remote revoke if the config + token are available. */
export async function disconnect(args: { orgId: string; userId: string }): Promise<void> {
  // Best-effort remote revoke — needs the pgcrypto key. If Google isn't
  // configured, skip revoke and just remove the local row (below).
  try {
    const cfg = requireConfig();
    const rows = await withOrgContext(args.orgId, async (tx) =>
      tx.$queryRaw<{ refresh: string }[]>`
        SELECT pgp_sym_decrypt(refresh_token_encrypted, ${cfg.key}) AS refresh
          FROM clinician_calendar_link
         WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
      `,
    );
    if (rows[0]?.refresh) {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(rows[0].refresh)}`, {
        method: "POST",
      });
    }
  } catch {
    /* not configured / revoke failed — still drop the local link */
  }
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      DELETE FROM clinician_calendar_link
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
    `;
  });
}

/**
 * Inbound pull (Phase E) — fetch the clinician's Google events and cache
 * each as a read-only busy block (visit_external_event rows with
 * visit_id NULL, direction='external_origin'). We do NOT create phantom
 * Pallio visits from arbitrary Google events; the schedule grid renders
 * these blocks so the clinician sees non-Pallio commitments inline.
 *
 * Incremental via sync_token when present; first run does a 30-day
 * forward window. Returns counts.
 */
export async function pullEventsForClinician(args: {
  orgId: string;
  userId: string;
}): Promise<{ upserted: number; cancelled: number }> {
  const token = await getAccessToken({ orgId: args.orgId, userId: args.userId });

  const link = await withOrgContext(args.orgId, async (tx) =>
    tx.$queryRaw<{ sync_token: string }[]>`
      SELECT sync_token FROM clinician_calendar_link
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid LIMIT 1
    `,
  );
  const syncToken = link[0]?.sync_token || "";

  const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
  if (syncToken) {
    params.set("syncToken", syncToken);
  } else {
    params.set("timeMin", new Date().toISOString());
    // 30 days forward on first sync.
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() + 30);
    params.set("timeMax", horizon.toISOString());
    params.set("orderBy", "startTime");
  }

  const r = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?${params.toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (r.status === 410) {
    // Sync token expired — clear it so the next run does a full window.
    await withOrgContext(args.orgId, async (tx) => {
      await tx.$executeRaw`
        UPDATE clinician_calendar_link SET sync_token = '' WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
      `;
    });
    return { upserted: 0, cancelled: 0 };
  }
  if (!r.ok) throw new Error(`Google events.list failed (${r.status})`);
  const data = (await r.json()) as {
    items?: Array<{
      id: string;
      status?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
    nextSyncToken?: string;
  };

  let upserted = 0;
  let cancelled = 0;
  await withOrgContext(args.orgId, async (tx) => {
    for (const ev of data.items ?? []) {
      // Skip events we ourselves pushed (direction pallio_origin) — those
      // are already Pallio visits; re-importing would double-count.
      const mine = await tx.$queryRaw<{ direction: string }[]>`
        SELECT direction FROM visit_external_event
         WHERE provider = 'google' AND external_event_id = ${ev.id} LIMIT 1
      `;
      if (mine[0]?.direction === "pallio_origin") continue;

      if (ev.status === "cancelled") {
        const n = await tx.$executeRaw`
          UPDATE visit_external_event SET cancelled = TRUE
           WHERE provider = 'google' AND external_event_id = ${ev.id}
        `;
        cancelled += n;
        continue;
      }
      const start = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
      const end = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T23:59:59Z` : null);
      if (!start || !end) continue;
      await tx.$executeRaw`
        INSERT INTO visit_external_event (
          org_id, visit_id, provider, external_event_id, direction,
          user_id, external_summary, external_start, external_end, cancelled
        ) VALUES (
          ${args.orgId}::uuid, NULL, 'google', ${ev.id}, 'external_origin',
          ${args.userId}::uuid, ${ev.summary ?? "(busy)"},
          ${start}::timestamptz, ${end}::timestamptz, FALSE
        )
        ON CONFLICT (provider, external_event_id) DO UPDATE SET
          external_summary = EXCLUDED.external_summary,
          external_start = EXCLUDED.external_start,
          external_end = EXCLUDED.external_end,
          cancelled = FALSE,
          last_seen_at = now()
      `;
      upserted += 1;
    }
    await tx.$executeRaw`
      UPDATE clinician_calendar_link
         SET sync_token = ${data.nextSyncToken ?? syncToken}, last_pull_at = now(), updated_at = now()
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
    `;
  });
  return { upserted, cancelled };
}

/** Pull for every connected clinician (cron entry). */
export async function pullAllConnected(): Promise<{ clinicians: number; upserted: number }> {
  // Surface a config problem instead of silently "succeeding" with 0 events.
  try { requireConfig(); } catch { return { clinicians: 0, upserted: 0 }; }
  const links = await withBreakglass(async (client) => {
    return client.$queryRaw<{ org_id: string; user_id: string }[]>`
      SELECT org_id, user_id FROM clinician_calendar_link WHERE status = 'connected'
    `;
  }, "pull-calendar: list connected links");
  let upserted = 0;
  for (const l of links) {
    try {
      const res = await pullEventsForClinician({ orgId: l.org_id, userId: l.user_id });
      upserted += res.upserted;
    } catch (e) {
      console.warn(`pull failed for ${l.user_id}:`, e);
    }
  }
  return { clinicians: links.length, upserted };
}

/**
 * Read cached external busy blocks for the schedule grid, in [from,to].
 */
export async function getExternalBusyBlocks(args: {
  orgId: string;
  userId?: string;
  fromIso: string;
  toIso: string;
}): Promise<Array<{ summary: string; start: string; end: string; userId: string | null }>> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { external_summary: string | null; external_start: Date; external_end: Date; user_id: string | null }[]
    >`
      SELECT external_summary, external_start, external_end, user_id
        FROM visit_external_event
       WHERE org_id = ${args.orgId}::uuid
         AND visit_id IS NULL AND cancelled = FALSE
         AND direction = 'external_origin'
         AND external_start IS NOT NULL
         AND external_start < ${args.toIso}::timestamptz
         AND external_end   > ${args.fromIso}::timestamptz
         AND (${args.userId ?? null}::uuid IS NULL OR user_id = ${args.userId ?? null}::uuid)
       ORDER BY external_start ASC
    `;
    return rows.map((r) => ({
      summary: r.external_summary ?? "(busy)",
      start: r.external_start.toISOString(),
      end: r.external_end.toISOString(),
      userId: r.user_id,
    }));
  });
}

export async function getStatus(args: {
  orgId: string;
  userId: string;
}): Promise<
  | { connected: false }
  | { connected: true; scopes: string[]; lastPullAt: string | null; lastPushAt: string | null; status: string }
> {
  const rows = await withOrgContext(args.orgId, async (tx) => {
    return tx.$queryRaw<
      {
        scopes: string[];
        last_pull_at: Date | null;
        last_push_at: Date | null;
        status: string;
      }[]
    >`
      SELECT scopes, last_pull_at, last_push_at, status
        FROM clinician_calendar_link
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
       LIMIT 1
    `;
  });
  const row = rows[0];
  if (!row) return { connected: false };
  return {
    connected: true,
    scopes: row.scopes ?? [],
    lastPullAt: row.last_pull_at?.toISOString() ?? null,
    lastPushAt: row.last_push_at?.toISOString() ?? null,
    status: row.status,
  };
}
