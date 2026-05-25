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
import { withOrgContext } from "@/lib/db";

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
    await fetch(
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

/** Disconnect — revoke + remove the row. */
export async function disconnect(args: { orgId: string; userId: string }): Promise<void> {
  const cfg = requireConfig();
  // Best-effort revoke; even if it fails, we drop the row.
  try {
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
    /* best effort */
  }
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      DELETE FROM clinician_calendar_link
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
    `;
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
