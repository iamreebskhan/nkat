/**
 * Clearinghouse connections (0120): saving them, testing them, and the payer
 * IDs each one knows the practice's payers by.
 *
 * SECRETS. Passwords, the SSH key and the API client secret are one JSON
 * object, encrypted with pgp_sym_encrypt under PALLIO_TOKEN_KEY (the key the
 * Google tokens of 0045 use) and decrypted only inside the request that
 * connects. No read here returns them; a view says only which are saved. A
 * connection with secrets cannot be saved until the key is set on the server.
 *
 * AUDIT. Every change writes one row with the vendor, the channels, the names
 * of the settings that changed and the names of the secrets set or cleared —
 * never a value, an ID or a host.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import {
  applySecretsPatch,
  connectionProblems,
  type ConnectionInput,
  type ConnectionSecrets,
  type ConnectionSettings,
  ConnectionSettingsSchema,
  SECRET_KEYS,
} from "./connection-settings";
import { assertPublicUrl } from "./endpoint-guard";
import { testAvailityApi } from "./transport/availity-api";
import { openSftp } from "./transport/sftp";
import { FILING_INDICATOR_BY_PAYER_TYPE, VENDOR_PROFILES, type BatchChannel, type ClearinghouseVendor, type RealtimeChannel } from "./vendors";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export interface ConnectionView {
  id: string;
  vendor: ClearinghouseVendor;
  vendorName: string;
  label: string;
  environment: "test" | "production";
  batchChannel: BatchChannel;
  realtimeChannel: RealtimeChannel;
  isPrimary: boolean;
  status: "active" | "disabled";
  settings: ConnectionSettings;
  secretsSaved: Record<(typeof SECRET_KEYS)[number], boolean>;
  /** Secrets are saved but the server's key is missing, so they cannot be read or used. */
  secretsUnreadable: boolean;
  hostKeySha256: string | null;
  lastTest: { at: string; ok: boolean; message: string | null } | null;
  lastPoll: { at: string; ok: boolean; message: string | null } | null;
  updatedAt: string;
  updatedByName: string | null;
}

interface Row {
  id: string;
  vendor: ClearinghouseVendor;
  label: string;
  environment: "test" | "production";
  batch_channel: BatchChannel;
  realtime_channel: RealtimeChannel;
  is_primary: boolean;
  status: "active" | "disabled";
  settings: unknown;
  /** The saved secrets' names; NULL when there are some but the key to read them is missing. */
  secret_keys: string[] | null;
  sftp_host_key_sha256: string | null;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_poll_at: Date | null;
  last_poll_ok: boolean | null;
  last_poll_message: string | null;
  updated_at: Date;
  updated_by_name: string | null;
}

/** The connection as loaded to connect with: settings and decrypted secrets. */
export interface LoadedConnection {
  id: string;
  vendor: ClearinghouseVendor;
  vendorName: string;
  label: string;
  environment: "test" | "production";
  batchChannel: BatchChannel;
  realtimeChannel: RealtimeChannel;
  isPrimary: boolean;
  status: "active" | "disabled";
  settings: ConnectionSettings;
  secrets: ConnectionSecrets;
  hostKeySha256: string | null;
}

function tokenKey(): string {
  const k = process.env.PALLIO_TOKEN_KEY;
  if (!k || k.length < 32) {
    throw new ValidationError(
      "Clearinghouse passwords and keys are stored encrypted, and the server has no encryption key yet (PALLIO_TOKEN_KEY). Ask whoever runs the server to set it, then save again.",
    );
  }
  return k;
}

function view(r: Row): ConnectionView {
  const saved = new Set(r.secret_keys ?? []);
  return {
    id: r.id,
    vendor: r.vendor,
    vendorName: VENDOR_PROFILES[r.vendor].name,
    label: r.label,
    environment: r.environment,
    batchChannel: r.batch_channel,
    realtimeChannel: r.realtime_channel,
    isPrimary: r.is_primary,
    status: r.status,
    settings: ConnectionSettingsSchema.parse(r.settings),
    secretsSaved: Object.fromEntries(SECRET_KEYS.map((k) => [k, saved.has(k)])) as ConnectionView["secretsSaved"],
    secretsUnreadable: r.secret_keys === null,
    hostKeySha256: r.sftp_host_key_sha256,
    lastTest: r.last_test_at ? { at: r.last_test_at.toISOString(), ok: Boolean(r.last_test_ok), message: r.last_test_message } : null,
    lastPoll: r.last_poll_at ? { at: r.last_poll_at.toISOString(), ok: Boolean(r.last_poll_ok), message: r.last_poll_message } : null,
    updatedAt: r.updated_at.toISOString(),
    updatedByName: r.updated_by_name,
  };
}

/**
 * The connections, with the NAMES of the secrets saved (read from the
 * decrypted object inside the database; the values never leave it here).
 */
async function readRows(tx: Tx, orgId: string, id: string | null): Promise<Row[]> {
  const key = process.env.PALLIO_TOKEN_KEY && process.env.PALLIO_TOKEN_KEY.length >= 32 ? process.env.PALLIO_TOKEN_KEY : null;
  return tx.$queryRaw<Row[]>`
    SELECT c.id, c.vendor, c.label, c.environment, c.batch_channel, c.realtime_channel, c.is_primary, c.status,
           c.settings,
           CASE
             WHEN c.secrets_enc IS NULL THEN ARRAY[]::text[]
             WHEN ${key}::text IS NULL THEN NULL
             ELSE ARRAY(SELECT jsonb_object_keys(pgp_sym_decrypt(c.secrets_enc, ${key}::text)::jsonb))
           END AS secret_keys,
           c.sftp_host_key_sha256, c.last_test_at, c.last_test_ok, c.last_test_message,
           c.last_poll_at, c.last_poll_ok, c.last_poll_message, c.updated_at,
           COALESCE(u.full_name, u.email) AS updated_by_name
      FROM clearinghouse_connection c
      LEFT JOIN app_user u ON u.id = c.updated_by_user_id
     WHERE c.org_id = ${orgId}::uuid AND (${id}::uuid IS NULL OR c.id = ${id}::uuid)
     ORDER BY c.is_primary DESC, c.created_at
  `;
}

export async function listConnections(args: { orgId: string }): Promise<ConnectionView[]> {
  return withOrgContext(args.orgId, async (tx) => (await readRows(tx, args.orgId, null)).map(view));
}

/** What a billing screen needs to offer a connection: no IDs, hosts or secrets. */
export interface ConnectionSummary {
  id: string;
  vendor: ClearinghouseVendor;
  vendorName: string;
  label: string;
  environment: "test" | "production";
  batchChannel: BatchChannel;
  realtimeChannel: RealtimeChannel;
  isPrimary: boolean;
  lastPoll: { at: string; ok: boolean; message: string | null } | null;
}

export async function listConnectionSummaries(args: { orgId: string }): Promise<ConnectionSummary[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string; vendor: ClearinghouseVendor; label: string; environment: "test" | "production"; batch_channel: BatchChannel; realtime_channel: RealtimeChannel; is_primary: boolean; last_poll_at: Date | null; last_poll_ok: boolean | null; last_poll_message: string | null }[]
    >`
      SELECT id, vendor, label, environment, batch_channel, realtime_channel, is_primary, last_poll_at, last_poll_ok, last_poll_message
        FROM clearinghouse_connection
       WHERE org_id = ${args.orgId}::uuid AND status = 'active'
       ORDER BY is_primary DESC, created_at
    `;
    return rows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      vendorName: VENDOR_PROFILES[r.vendor].name,
      label: r.label,
      environment: r.environment,
      batchChannel: r.batch_channel,
      realtimeChannel: r.realtime_channel,
      isPrimary: r.is_primary,
      lastPoll: r.last_poll_at ? { at: r.last_poll_at.toISOString(), ok: Boolean(r.last_poll_ok), message: r.last_poll_message } : null,
    }));
  });
}

export async function getConnection(args: { orgId: string; id: string }): Promise<ConnectionView> {
  return withOrgContext(args.orgId, async (tx) => {
    const r = (await readRows(tx, args.orgId, args.id))[0];
    if (!r) throw new NotFoundError("Clearinghouse connection not found.");
    return view(r);
  });
}

/**
 * For the services that connect: the settings and the decrypted secrets.
 * Server only. A caller building a file to download needs no secrets and
 * passes withSecrets: false, so it works before the server has its key.
 */
export async function loadConnection(tx: Tx, orgId: string, id: string, opts: { withSecrets?: boolean } = {}): Promise<LoadedConnection> {
  const rows = await tx.$queryRaw<
    (Omit<Row, "secret_keys" | "updated_by_name"> & { has_secrets: boolean })[]
  >`
    SELECT id, vendor, label, environment, batch_channel, realtime_channel, is_primary, status, settings,
           secrets_enc IS NOT NULL AS has_secrets, sftp_host_key_sha256,
           last_test_at, last_test_ok, last_test_message, last_poll_at, last_poll_ok, last_poll_message, updated_at
      FROM clearinghouse_connection
     WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid
  `;
  const r = rows[0];
  if (!r) throw new NotFoundError("Clearinghouse connection not found.");
  let secrets: ConnectionSecrets = {};
  if (r.has_secrets && opts.withSecrets !== false) {
    const dec = await tx.$queryRaw<{ s: string }[]>`
      SELECT pgp_sym_decrypt(secrets_enc, ${tokenKey()}::text) AS s
        FROM clearinghouse_connection WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid
    `;
    secrets = JSON.parse(dec[0]?.s ?? "{}") as ConnectionSecrets;
  }
  return {
    id: r.id,
    vendor: r.vendor,
    vendorName: VENDOR_PROFILES[r.vendor].name,
    label: r.label,
    environment: r.environment,
    batchChannel: r.batch_channel,
    realtimeChannel: r.realtime_channel,
    isPrimary: r.is_primary,
    status: r.status,
    settings: ConnectionSettingsSchema.parse(r.settings),
    secrets,
    hostKeySha256: r.sftp_host_key_sha256,
  };
}

/** The setting paths that differ, for the audit row: "sftp.host", "submitter.id". */
export function changedSettingPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (typeof before !== "object" || typeof after !== "object" || before === null || after === null || Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix.replace(/\.$/, "")];
  }
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  return [...keys].flatMap((k) =>
    changedSettingPaths((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k], `${prefix}${k}.`),
  );
}

async function assertEndpoints(settings: ConnectionSettings, input: { batchChannel: BatchChannel; realtimeChannel: RealtimeChannel }): Promise<void> {
  if (input.realtimeChannel === "core_soap" && settings.core) await assertPublicUrl(settings.core.url);
  if (input.realtimeChannel === "availity_api" && settings.availityApi) await assertPublicUrl(settings.availityApi.baseUrl);
  // The SFTP host is resolved and checked when it is connected to (sftp.ts),
  // so a name that does not resolve yet can still be saved during enrollment.
}

async function writeSecrets(tx: Tx, orgId: string, id: string, secrets: ConnectionSecrets): Promise<void> {
  const any = SECRET_KEYS.some((k) => secrets[k]);
  if (!any) {
    await tx.$executeRaw`UPDATE clearinghouse_connection SET secrets_enc = NULL WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid`;
    return;
  }
  await tx.$executeRaw`
    UPDATE clearinghouse_connection SET secrets_enc = pgp_sym_encrypt(${JSON.stringify(secrets)}::text, ${tokenKey()}::text)
     WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid
  `;
}

async function clearOtherPrimaries(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE clearinghouse_connection SET is_primary = false
     WHERE org_id = ${orgId}::uuid AND id <> ${id}::uuid AND is_primary
  `;
}

export async function createConnection(args: { orgId: string; userId: string; input: ConnectionInput }): Promise<ConnectionView> {
  const i = args.input;
  const secrets = applySecretsPatch({}, i.secrets);
  const problems = connectionProblems({ ...i, secrets });
  if (problems.length > 0) throw new ValidationError(problems.join(" "));
  await assertEndpoints(i.settings, i);
  const id = await withOrgContext(args.orgId, async (tx) => {
    const dup = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM clearinghouse_connection WHERE org_id = ${args.orgId}::uuid AND label = ${i.label}
    `;
    if (dup[0]) throw new ValidationError(`A connection named "${i.label}" already exists. Give this one another name.`);
    const firstActive = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM clearinghouse_connection WHERE org_id = ${args.orgId}::uuid AND status = 'active'
    `;
    const primary = i.isPrimary || Number(firstActive[0]?.n ?? 0) === 0;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO clearinghouse_connection (
        org_id, vendor, label, environment, batch_channel, realtime_channel, settings, is_primary,
        created_by_user_id, updated_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${i.vendor}, ${i.label}, ${i.environment}, ${i.batchChannel}, ${i.realtimeChannel},
        ${JSON.stringify(i.settings)}::jsonb, false, ${args.userId}::uuid, ${args.userId}::uuid
      )
      RETURNING id
    `;
    const newId = rows[0]!.id;
    await writeSecrets(tx, args.orgId, newId, secrets);
    if (primary) {
      await clearOtherPrimaries(tx, args.orgId, newId);
      await tx.$executeRaw`UPDATE clearinghouse_connection SET is_primary = true WHERE id = ${newId}::uuid AND org_id = ${args.orgId}::uuid`;
    }
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "clearinghouse_connection",
      targetType: "clearinghouse_connection",
      targetId: newId,
      payload: {
        op: "create",
        vendor: i.vendor,
        environment: i.environment,
        batchChannel: i.batchChannel,
        realtimeChannel: i.realtimeChannel,
        secrets: SECRET_KEYS.filter((k) => secrets[k]),
      },
    });
    return newId;
  });
  return getConnection({ orgId: args.orgId, id });
}

export async function updateConnection(args: { orgId: string; userId: string; id: string; input: ConnectionInput }): Promise<ConnectionView> {
  const i = args.input;
  await withOrgContext(args.orgId, async (tx) => {
    const current = await loadConnection(tx, args.orgId, args.id);
    if (current.vendor !== i.vendor) throw new ValidationError("A connection's clearinghouse cannot change; add a new connection instead.");
    const secrets = applySecretsPatch(current.secrets, i.secrets);
    const problems = connectionProblems({ ...i, secrets });
    if (problems.length > 0) throw new ValidationError(problems.join(" "));
    await assertEndpoints(i.settings, i);
    const dup = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM clearinghouse_connection
       WHERE org_id = ${args.orgId}::uuid AND label = ${i.label} AND id <> ${args.id}::uuid
    `;
    if (dup[0]) throw new ValidationError(`A connection named "${i.label}" already exists. Give this one another name.`);
    // A different SFTP host is a different server: its key is pinned afresh
    // on the next test, never carried over from the old host.
    const hostChanged = (current.settings.sftp?.host ?? null) !== (i.settings.sftp?.host ?? null)
      || (current.settings.sftp?.port ?? null) !== (i.settings.sftp?.port ?? null);
    await tx.$executeRaw`
      UPDATE clearinghouse_connection SET
        label = ${i.label}, environment = ${i.environment}, batch_channel = ${i.batchChannel},
        realtime_channel = ${i.realtimeChannel}, settings = ${JSON.stringify(i.settings)}::jsonb,
        sftp_host_key_sha256 = CASE WHEN ${hostChanged} THEN NULL ELSE sftp_host_key_sha256 END,
        updated_by_user_id = ${args.userId}::uuid, updated_at = now()
       WHERE org_id = ${args.orgId}::uuid AND id = ${args.id}::uuid
    `;
    await writeSecrets(tx, args.orgId, args.id, secrets);
    // Main is what the form says: ticked takes it from any other, unticked
    // gives it up (screens then start with the first connection).
    if (i.isPrimary) await clearOtherPrimaries(tx, args.orgId, args.id);
    await tx.$executeRaw`UPDATE clearinghouse_connection SET is_primary = ${i.isPrimary} WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid`;
    const secretsChanged = SECRET_KEYS.filter((k) => i.secrets[k] !== undefined);
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "clearinghouse_connection",
      targetType: "clearinghouse_connection",
      targetId: args.id,
      payload: {
        op: "update",
        vendor: i.vendor,
        environment: i.environment,
        batchChannel: i.batchChannel,
        realtimeChannel: i.realtimeChannel,
        fields: [
          ...(current.label !== i.label ? ["label"] : []),
          ...(current.environment !== i.environment ? ["environment"] : []),
          ...(current.batchChannel !== i.batchChannel ? ["batchChannel"] : []),
          ...(current.realtimeChannel !== i.realtimeChannel ? ["realtimeChannel"] : []),
          ...(current.isPrimary !== i.isPrimary ? ["isPrimary"] : []),
          ...changedSettingPaths(current.settings, i.settings).map((p) => `settings.${p}`),
        ],
        secrets: secretsChanged,
        ...(hostChanged ? { hostKeyReset: true } : {}),
      },
    });
  });
  return getConnection({ orgId: args.orgId, id: args.id });
}

export async function setConnectionStatus(args: { orgId: string; userId: string; id: string; status: "active" | "disabled" }): Promise<ConnectionView> {
  await withOrgContext(args.orgId, async (tx) => {
    const c = await loadConnection(tx, args.orgId, args.id);
    await tx.$executeRaw`
      UPDATE clearinghouse_connection SET status = ${args.status},
             is_primary = CASE WHEN ${args.status} = 'disabled' THEN false ELSE is_primary END,
             updated_by_user_id = ${args.userId}::uuid, updated_at = now()
       WHERE org_id = ${args.orgId}::uuid AND id = ${args.id}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "clearinghouse_connection", targetType: "clearinghouse_connection",
      targetId: args.id, payload: { op: args.status === "disabled" ? "disable" : "enable", vendor: c.vendor },
    });
  });
  return getConnection({ orgId: args.orgId, id: args.id });
}

/** Removes the connection and its secrets; the files sent through it keep their history. */
export async function deleteConnection(args: { orgId: string; userId: string; id: string }): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    const c = await loadConnection(tx, args.orgId, args.id);
    await tx.$executeRaw`DELETE FROM clearinghouse_connection WHERE org_id = ${args.orgId}::uuid AND id = ${args.id}::uuid`;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "clearinghouse_connection", targetType: "clearinghouse_connection",
      targetId: args.id, payload: { op: "delete", vendor: c.vendor },
    });
  });
}

/** Forget the pinned host key, so the next test pins whatever the server presents. */
export async function resetHostKey(args: { orgId: string; userId: string; id: string }): Promise<ConnectionView> {
  await withOrgContext(args.orgId, async (tx) => {
    const c = await loadConnection(tx, args.orgId, args.id);
    await tx.$executeRaw`
      UPDATE clearinghouse_connection SET sftp_host_key_sha256 = NULL, updated_by_user_id = ${args.userId}::uuid, updated_at = now()
       WHERE org_id = ${args.orgId}::uuid AND id = ${args.id}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "clearinghouse_connection", targetType: "clearinghouse_connection",
      targetId: args.id, payload: { op: "reset_host_key", vendor: c.vendor },
    });
  });
  return getConnection({ orgId: args.orgId, id: args.id });
}

export interface TestStep {
  channel: "sftp" | "core_soap" | "availity_api";
  ok: boolean;
  message: string;
}

/**
 * Test each channel without sending any patient's data: SFTP connects, pins
 * the host key on a first test and lists every folder named; CORE checks the
 * endpoint answers over TLS (its password is checked by the first real
 * question); Availity's API asks for a token.
 */
export async function testConnection(args: { orgId: string; userId: string; id: string }): Promise<{ ok: boolean; steps: TestStep[]; connection: ConnectionView }> {
  const c = await withOrgContext(args.orgId, (tx) => loadConnection(tx, args.orgId, args.id));
  const steps: TestStep[] = [];
  let pinned: string | null = null;
  if (c.batchChannel === "sftp" && c.settings.sftp) {
    const s = c.settings.sftp;
    try {
      const session = await openSftp({
        host: s.host, port: s.port, username: s.username, password: c.secrets.sftpPassword,
        privateKey: c.secrets.sftpPrivateKey, passphrase: c.secrets.sftpPassphrase, hostKeySha256: c.hostKeySha256,
      });
      try {
        if (!c.hostKeySha256) pinned = session.hostKeySha256;
        const seen: string[] = [];
        for (const dir of [s.uploadDir, ...s.downloadDirs]) {
          const files = await session.list(dir);
          seen.push(`${dir || "(home)"}: ${files.length} file${files.length === 1 ? "" : "s"}`);
        }
        steps.push({ channel: "sftp", ok: true, message: `Connected to ${s.host} as ${s.username}. ${seen.join("; ")}.${pinned ? " Host key recorded." : ""}` });
      } finally {
        session.close();
      }
    } catch (err) {
      steps.push({ channel: "sftp", ok: false, message: err instanceof Error ? err.message : "SFTP failed." });
    }
  }
  if (c.realtimeChannel === "core_soap" && c.settings.core) {
    try {
      const url = await assertPublicUrl(c.settings.core.url);
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000), redirect: "manual" });
      steps.push({ channel: "core_soap", ok: true, message: `${url.hostname} answers over ${url.protocol === "https:" ? "TLS" : "HTTP"} (HTTP ${res.status}). The CORE password is checked by the first eligibility or status question.` });
    } catch (err) {
      steps.push({ channel: "core_soap", ok: false, message: err instanceof ValidationError ? err.message : "The CORE endpoint could not be reached." });
    }
  }
  if (c.realtimeChannel === "availity_api" && c.settings.availityApi) {
    try {
      await testAvailityApi(
        { ...c.settings.availityApi, clientSecret: c.secrets.apiClientSecret ?? "" },
        `${c.id}:${c.settings.availityApi.clientId}`,
      );
      steps.push({ channel: "availity_api", ok: true, message: "Availity issued a token for this client ID." });
    } catch (err) {
      steps.push({ channel: "availity_api", ok: false, message: err instanceof Error ? err.message : "Availity's API failed." });
    }
  }
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const message = steps.length === 0
    ? "Nothing to test: this connection has neither SFTP nor a real-time channel."
    : steps.map((s) => s.message).join(" ").slice(0, 500);
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE clearinghouse_connection SET
        last_test_at = now(), last_test_ok = ${ok}, last_test_message = ${message},
        sftp_host_key_sha256 = COALESCE(sftp_host_key_sha256, ${pinned})
       WHERE org_id = ${args.orgId}::uuid AND id = ${args.id}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "clearinghouse_connection", targetType: "clearinghouse_connection",
      targetId: args.id,
      payload: { op: "test", vendor: c.vendor, ok, channels: steps.map((s) => `${s.channel}:${s.ok ? "ok" : "failed"}`), ...(pinned ? { hostKeyPinned: true } : {}) },
    });
  });
  return { ok, steps, connection: await getConnection({ orgId: args.orgId, id: args.id }) };
}

export interface PayerIdRow {
  payerId: string;
  payerName: string;
  payerType: string;
  states: string[];
  /** The payer roster's own external ID, a starting point (it is not clearinghouse-specific). */
  rosterPayerId: string | null;
  externalPayerId: string | null;
  claimFilingIndicator: string | null;
  /** SBR09 from the payer's type when none is set here. */
  defaultFilingIndicator: string;
  /** Claims in Pallio billed to this payer: the ones worth mapping first. */
  claims: number;
}

export async function listPayerIds(args: { orgId: string; connectionId: string }): Promise<PayerIdRow[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const c = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM clearinghouse_connection WHERE org_id = ${args.orgId}::uuid AND id = ${args.connectionId}::uuid
    `;
    if (!c[0]) throw new NotFoundError("Clearinghouse connection not found.");
    const rows = await tx.$queryRaw<
      {
        payer_id: string; name: string; payer_type: string; states: string[] | null; roster_payer_id: string | null;
        external_payer_id: string | null; claim_filing_indicator: string | null; claims: bigint;
      }[]
    >`
      SELECT p.id AS payer_id, p.name::text AS name, p.payer_type,
             (SELECT array_agg(DISTINCT btrim(s) ORDER BY btrim(s)) FROM unnest(p.states_served) s) AS states,
             p.external_payer_id AS roster_payer_id,
             m.external_payer_id, m.claim_filing_indicator,
             (SELECT count(*) FROM superbill s WHERE s.org_id = ${args.orgId}::uuid AND s.payer_id = p.id) AS claims
        FROM payer p
        LEFT JOIN clearinghouse_payer_id m ON m.payer_id = p.id AND m.connection_id = ${args.connectionId}::uuid
       WHERE p.active OR m.payer_id IS NOT NULL
       ORDER BY 8 DESC, p.name
    `;
    return rows.map((r) => ({
      payerId: r.payer_id,
      payerName: r.name,
      payerType: r.payer_type,
      states: r.states ?? [],
      rosterPayerId: r.roster_payer_id,
      externalPayerId: r.external_payer_id,
      claimFilingIndicator: r.claim_filing_indicator,
      defaultFilingIndicator: FILING_INDICATOR_BY_PAYER_TYPE[r.payer_type] ?? "CI",
      claims: Number(r.claims),
    }));
  });
}

export async function setPayerIds(args: {
  orgId: string;
  userId: string;
  connectionId: string;
  rows: { payerId: string; externalPayerId: string | null; claimFilingIndicator: string | null }[];
}): Promise<PayerIdRow[]> {
  await withOrgContext(args.orgId, async (tx) => {
    const c = await tx.$queryRaw<{ vendor: string }[]>`
      SELECT vendor FROM clearinghouse_connection WHERE org_id = ${args.orgId}::uuid AND id = ${args.connectionId}::uuid
    `;
    if (!c[0]) throw new NotFoundError("Clearinghouse connection not found.");
    let set = 0;
    let cleared = 0;
    for (const r of args.rows) {
      const known = await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM payer WHERE id = ${r.payerId}::uuid`;
      if (!known[0]) throw new ValidationError("Unknown payer in the list. Reload the page and try again.");
      if (!r.externalPayerId) {
        await tx.$executeRaw`
          DELETE FROM clearinghouse_payer_id WHERE connection_id = ${args.connectionId}::uuid AND payer_id = ${r.payerId}::uuid
        `;
        cleared += 1;
        continue;
      }
      await tx.$executeRaw`
        INSERT INTO clearinghouse_payer_id (connection_id, org_id, payer_id, external_payer_id, claim_filing_indicator, updated_by_user_id)
        VALUES (${args.connectionId}::uuid, ${args.orgId}::uuid, ${r.payerId}::uuid, ${r.externalPayerId}, ${r.claimFilingIndicator}, ${args.userId}::uuid)
        ON CONFLICT (connection_id, payer_id) DO UPDATE SET
          external_payer_id = EXCLUDED.external_payer_id,
          claim_filing_indicator = EXCLUDED.claim_filing_indicator,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = now()
      `;
      set += 1;
    }
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "clearinghouse_connection", targetType: "clearinghouse_connection",
      targetId: args.connectionId, payload: { op: "payer_ids", vendor: c[0].vendor, set, cleared },
    });
  });
  return listPayerIds({ orgId: args.orgId, connectionId: args.connectionId });
}
