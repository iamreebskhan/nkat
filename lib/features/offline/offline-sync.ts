/**
 * Sending what was written offline (browser only), when the server can be
 * reached again (Mark Q8 default: draft offline, sign on reconnect).
 *
 * Each draft goes through the route a note written online uses, the note
 * section PATCH or the vitals PUT, so the same permission, visit-access and
 * signed-note checks apply. It goes only onto the version it was written
 * against (planDraft): anything else stays on the device with the reason, for
 * the clinician to settle; nothing on the server is overwritten unseen. Signing
 * is never done here: it stays a deliberate act on the visit page.
 */
import {
  OFFLINE_VITALS_KEYS,
  draftContent,
  listText,
  planDraft,
  proseText,
  type OfflineDraft,
  type OfflineSnapshot,
} from "./offline";
import { deleteDraft, getSnapshot, listDrafts, putDraft, putSnapshot } from "./offline-store";

export interface SendResult {
  sent: number;
  kept: number;
  /** The server could not be reached, or the session has ended: nothing more was tried. */
  stopped: "offline" | "signed_out" | null;
}

interface NoteSection {
  sectionKey: string;
  kind: string;
  content: unknown;
  updatedAt: string | null;
}
interface Note {
  sections: NoteSection[];
  vitals: (Record<string, unknown> & { recordedAt: string | null }) | null;
}

class Stop extends Error {
  constructor(readonly why: "offline" | "signed_out") {
    super(why);
  }
}

async function call(url: string, init?: RequestInit): Promise<{ status: number; body: { success?: boolean; data?: unknown; error?: string } | null }> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new Stop("offline");
  }
  if (res.status === 401) throw new Stop("signed_out");
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The note as the server has it now, put back into the device's copy. */
async function refreshCopy(visitId: string, note: Note): Promise<void> {
  const snap: OfflineSnapshot | undefined = await getSnapshot();
  const v = snap?.visits.find((x) => x.id === visitId);
  if (!snap || !v) return;
  v.sections = v.sections.map((s) => {
    const now = note.sections.find((n) => n.sectionKey === s.sectionKey);
    return now ? { ...s, text: s.kind === "list" ? listText(now.content) : proseText(now.content), updatedAt: now.updatedAt } : s;
  });
  if (v.vitals && note.vitals) {
    const now = note.vitals;
    v.vitals = {
      values: {
        ...Object.fromEntries(OFFLINE_VITALS_KEYS.map((k) => [k, (now[k] as number | null | undefined) ?? null])),
        notes: (now.notes as string | null | undefined) ?? null,
      },
      recordedAt: now.recordedAt,
    };
  }
  await putSnapshot(snap);
}

/** Send every draft on the device that may go; keep the rest with the reason. */
export async function sendDrafts(): Promise<SendResult> {
  const drafts = await listDrafts();
  const byVisit = new Map<string, OfflineDraft[]>();
  for (const d of drafts) byVisit.set(d.visitId, [...(byVisit.get(d.visitId) ?? []), d]);
  let sent = 0;
  let kept = 0;
  try {
    for (const [visitId, ds] of byVisit) {
      const visit = await call(`/api/visits/${visitId}`);
      const note = await call(`/api/visits/${visitId}/note`);
      if (!visit.body?.success || !note.body?.success) {
        const problem = visit.body?.error ?? note.body?.error ?? "The visit could not be read.";
        for (const d of ds) await putDraft({ ...d, problem });
        kept += ds.length;
        continue;
      }
      const status = (visit.body.data as { status: string }).status;
      const n = note.body.data as Note;
      let wrote = false;
      for (const d of ds) {
        const isVitals = d.kind === "vitals";
        const section = n.sections.find((s) => s.sectionKey === d.sectionKey);
        const plan = planDraft(d, {
          visitStatus: status,
          updatedAt: isVitals ? (n.vitals?.recordedAt ?? null) : (section?.updatedAt ?? null),
          sectionExists: Boolean(section),
        });
        if (!plan.send) {
          await putDraft({ ...d, problem: plan.problem });
          kept++;
          continue;
        }
        const res = isVitals
          ? await call(`/api/visits/${visitId}/vitals`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(d.vitals ?? {}),
            })
          : await call(`/api/visits/${visitId}/note`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sectionKey: d.sectionKey, content: draftContent(d) }),
            });
        if (res.body?.success) {
          await deleteDraft(d.id);
          sent++;
          wrote = true;
        } else {
          await putDraft({ ...d, problem: res.body?.error ?? `Not sent (HTTP ${res.status}).` });
          kept++;
        }
      }
      if (wrote) {
        const fresh = await call(`/api/visits/${visitId}/note`);
        if (fresh.body?.success) await refreshCopy(visitId, fresh.body.data as Note);
      }
    }
  } catch (err) {
    // Everything not yet sent stays on the device as it was.
    if (err instanceof Stop) return { sent, kept: (await listDrafts()).length, stopped: err.why };
    throw err;
  }
  return { sent, kept, stopped: null };
}
