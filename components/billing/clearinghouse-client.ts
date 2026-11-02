/**
 * The browser side of sending claims through a clearinghouse (0120), shared
 * by the superbill queue and a bill's own page so both say the same things.
 *
 * Every call goes through the API routes; nothing here decides what may be
 * sent. The server runs every check and says why in a sentence, and this
 * shows that sentence — except the one refusal a person can answer here: a
 * note missing what the payer requires, which asks for the reason (as the
 * queue's "Record as submitted" does) and sends again with it.
 */
import { askReason } from "./ask-reason";

export interface ConnectionChoice {
  id: string;
  vendor: string;
  vendorName: string;
  label: string;
  environment: "test" | "production";
  batchChannel: "sftp" | "manual";
  realtimeChannel: "none" | "core_soap" | "availity_api";
  isPrimary: boolean;
  lastPoll: { at: string; ok: boolean; message: string | null } | null;
}

export interface ClaimClearinghouseStatus {
  vendorName: string;
  filename: string;
  sentAt: string;
  sendState: string;
  ackState: string | null;
  payerState: string | null;
  /** The file went to the clearinghouse's test system and moved no claim. */
  test: boolean;
  summary: string;
  /** After a rejection or a failed send: what to put right before sending again. */
  nextStep: string | null;
}

/** No connections when the answer is not one (a refusal, a 403 for a role without billing, a network error). */
export async function fetchConnections(): Promise<ConnectionChoice[]> {
  try {
    const d = await fetch("/api/billing/clearinghouse/connections").then((r) => r.json());
    const list = d?.success ? d.data?.connections : null;
    return Array.isArray(list) ? (list as ConnectionChoice[]) : [];
  } catch {
    return [];
  }
}

export async function fetchClaimStatuses(ids: string[]): Promise<Record<string, ClaimClearinghouseStatus>> {
  if (ids.length === 0) return {};
  try {
    const d = await fetch(`/api/billing/clearinghouse/status?ids=${ids.join(",")}`).then((r) => r.json());
    const map = d?.success ? d.data?.status : null;
    return map && typeof map === "object" ? (map as Record<string, ClaimClearinghouseStatus>) : {};
  } catch {
    return {};
  }
}

/** Hands the browser the 837P file. */
function save(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * What went out but may trouble a payer, one line per kind of warning with
 * the claims it is on ("no patient sex on the chart (sent as unknown):
 * 44D55C84CC39, 4AA354481786"), so four claims missing the same thing read
 * as one line, not four.
 */
export function warningLines(w: { claimRef: string; warnings: string[] }[]): string[] {
  const byWarning = new Map<string, string[]>();
  for (const x of w) for (const warning of x.warnings) byWarning.set(warning, [...(byWarning.get(warning) ?? []), x.claimRef]);
  return [...byWarning].map(([warning, refs]) => `• ${warning}: ${refs.length > 3 ? `${refs.length} claims` : refs.join(", ")}`);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export interface ClearinghouseOutcome {
  ok: boolean;
  /** May hold line breaks: the screens show it with them. */
  text: string;
}

export async function downloadClaimFile(connection: ConnectionChoice, superbillIds: string[]): Promise<ClearinghouseOutcome> {
  try {
    const r = await fetch("/api/billing/clearinghouse/claim-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.id, superbillIds }),
    });
    const d = await r.json();
    if (!d.success) return { ok: false, text: d.error ?? "The claim file wasn't created. Try again." };
    save(d.data.filename, d.data.content);
    const n: number = d.data.claims;
    const v = connection.vendorName;
    const warned = warningLines(d.data.warnings ?? []);
    return {
      ok: true,
      text: [
        `Downloaded ${d.data.filename} (${n} ${plural(n, "claim", "claims")}).`,
        connection.environment === "test"
          ? `Next: upload it to ${v}'s test system. Test files never reach the payer, so the ${plural(n, "claim stays", "claims stay")} as ${plural(n, "it is", "they are")}.`
          : `Next: upload it in ${v}. When ${v}'s responses come back, upload them on Billing → Clearinghouse; each claim is marked Submitted once the payer accepts it.`,
        ...(warned.length > 0 ? ["Worth checking before the payer does:", ...warned] : []),
      ].join("\n"),
    };
  } catch {
    return { ok: false, text: "Couldn't reach Pallio, so the claim file wasn't created. Check your connection and try again." };
  }
}

export async function sendClaims(connection: ConnectionChoice, superbillIds: string[]): Promise<ClearinghouseOutcome> {
  const post = async (extra: Record<string, unknown> = {}) => {
    const r = await fetch("/api/billing/clearinghouse/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.id, superbillIds, ...extra }),
    });
    return r.json();
  };
  try {
    let d = await post();
    if (!d.success && d.data?.documentationIncomplete) {
      const reason = askReason(
        `${d.error}\n\nTo send anyway, enter the reason (at least 10 characters). It is recorded on each claim's history.`,
      );
      if (reason === null) return { ok: false, text: "Not sent. Nothing changed." };
      d = await post({ documentationOverride: { reason } });
    }
    if (!d.success) return { ok: false, text: d.error ?? "Not sent. Nothing changed; try again." };
    const r = d.data as { state: string; test: boolean; filename: string; claims: number; error: string | null; notRecorded: { claimRef: string; message: string }[]; warnings: { claimRef: string; warnings: string[] }[] };
    const v = connection.vendorName;
    if (r.state !== "sent") {
      return { ok: false, text: `Not sent: ${v} couldn't be reached (${r.error ?? "the upload failed"}). Nothing left Pallio and the claims haven't changed. Try again, or ask an admin to run “Test connection”.` };
    }
    const n = r.claims;
    const warned = warningLines(r.warnings);
    const missed = r.notRecorded.map((x) => `• ${x.claimRef}: ${x.message}`);
    return {
      ok: missed.length === 0,
      text: [
        r.test
          ? `Sent ${n} ${plural(n, "claim", "claims")} to ${v}'s test system in ${r.filename}. Test files never reach the payer, so the ${plural(n, "claim stays", "claims stay")} as ${plural(n, "it is", "they are")}. ${v}'s responses show on Billing → Clearinghouse.`
          : `Sent ${n} ${plural(n, "claim", "claims")} to ${v} in ${r.filename}. ${plural(n, "It's", "They're")} now Submitted; Pallio updates ${plural(n, "it", "each one")} when ${v} and the payer respond.`,
        ...(warned.length > 0 ? ["Worth checking before the payer does:", ...warned] : []),
        ...(missed.length > 0 ? ["Sent, but Pallio couldn't mark these Submitted. Use “Record as submitted” for them on the Superbills page:", ...missed] : []),
      ].join("\n"),
    };
  } catch {
    return { ok: false, text: "Couldn't confirm the send: the connection to Pallio dropped. Check Billing → Clearinghouse before sending again, because the file may have gone." };
  }
}

/** The question before a send, specific about what happens. */
export function sendQuestion(connection: ConnectionChoice, claimRefs: string[]): string {
  const n = claimRefs.length;
  const what = n === 1 ? `claim ${claimRefs[0]}` : `${n} claims`;
  return connection.environment === "test"
    ? `Send ${what} to ${connectionName(connection)}?\n\nThis is a test connection: ${connection.vendorName} checks the file but never passes it to a payer, so nothing is marked Submitted.`
    : `Send ${what} to ${connection.vendorName}?\n\n${connection.vendorName} passes ${plural(n, "it", "them")} to the payer, and ${plural(n, "it's", "they're")} marked Submitted.`;
}

/** A connection as a picker names it: its label, and test or production unless the label says so already. */
export function connectionName(c: ConnectionChoice): string {
  return c.label.toLowerCase().includes(c.environment) ? c.label : `${c.label} · ${c.environment}`;
}

/** The connection a screen starts with: the primary, else the first. */
export function defaultConnection(cs: ConnectionChoice[]): ConnectionChoice | null {
  return cs.find((c) => c.isPrimary) ?? cs[0] ?? null;
}
