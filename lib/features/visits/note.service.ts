/**
 * The structured visit note: template, sections and vitals.
 *
 * Reads and writes the tables 0088 introduced. The rule that shapes everything
 * here is that a section is individually addressable — "does this note have an
 * HPI" has to be answerable by the database, because that is the question an
 * audit asks and the question payer documentation rules will need.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { dateColumnIso } from "@/lib/features/org/org-date";

import {
  DEFAULT_NOTE_SECTIONS,
  DEFAULT_TEMPLATE_NAME,
  sectionContentIsEmpty,
  sectionIsRequiredFor,
  type NoteSectionKind,
} from "./note-template";

export interface NoteSectionView {
  sectionKey: string;
  label: string;
  helpText: string | null;
  kind: NoteSectionKind;
  isRequired: boolean;
  sortOrder: number;
  content: unknown;
  isEmpty: boolean;
  /** Set when this section's text was brought forward from an earlier visit. */
  carriedFromVisitId: string | null;
  /** True until the clinician edits it — the flag an auditor cares about. */
  carriedUnchanged: boolean;
  /**
   * When this section's stored content last changed. The editor keys off it:
   * TipTap builds its document once and ignores later prop changes, so without
   * a key that moves when the server's copy moves, a section whose content
   * arrived after mount (carry-forward) keeps showing a stale empty editor —
   * and the next blur saves that emptiness over the real text.
   */
  updatedAt: string | null;
}

export interface VitalsView {
  heightCm: number | null;
  weightKg: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  respRate: number | null;
  temperatureC: number | null;
  spo2Percent: number | null;
  ppsPercent: number | null;
  painScore: number | null;
  notes: string | null;
  recordedAt: string | null;
}

export interface VisitNoteView {
  templateId: string;
  templateName: string;
  templateVersion: number;
  sections: NoteSectionView[];
  vitals: VitalsView | null;
  /** Required sections still empty — what blocks signing. */
  missingRequired: { sectionKey: string; label: string }[];
}

const EMPTY_VITALS: VitalsView = {
  heightCm: null, weightKg: null, bpSystolic: null, bpDiastolic: null,
  heartRate: null, respRate: null, temperatureC: null, spo2Percent: null,
  ppsPercent: null, painScore: null, notes: null, recordedAt: null,
};

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** One version of an org's note template. */
export interface NoteTemplateRef {
  id: string;
  name: string;
  version: number;
}

/**
 * Resolve the org's active template, creating version 1 from the shipped
 * default the first time. Idempotent and safe to call on every note read.
 */
export async function ensureNoteTemplate(args: {
  orgId: string;
  userId?: string;
}): Promise<NoteTemplateRef> {
  return withOrgContext(args.orgId, (tx) => activeTemplate(tx, args));
}

async function activeTemplate(
  tx: Tx,
  args: { orgId: string; userId?: string },
): Promise<NoteTemplateRef> {
  const existing = await tx.$queryRaw<NoteTemplateRef[]>`
    SELECT id, name, version FROM note_template
     WHERE org_id = ${args.orgId}::uuid AND is_active
     LIMIT 1
  `;
  if (existing[0]) return existing[0];

  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO note_template (org_id, name, version, is_active, source, created_by_user_id)
    VALUES (${args.orgId}::uuid, ${DEFAULT_TEMPLATE_NAME}, 1, TRUE, 'default',
            ${args.userId ?? null}::uuid)
    RETURNING id
  `;
  const templateId = created[0].id;

  for (const [i, s] of DEFAULT_NOTE_SECTIONS.entries()) {
    await tx.$executeRaw`
      INSERT INTO note_template_section
        (org_id, template_id, section_key, label, help_text, kind, is_required,
         not_required_for_visit_types, sort_order)
      VALUES (${args.orgId}::uuid, ${templateId}::uuid, ${s.sectionKey}, ${s.label},
              ${s.helpText ?? null}, ${s.kind}, ${s.isRequired},
              ${s.notRequiredForVisitTypes ?? []}::text[], ${i})
    `;
  }
  return { id: templateId, name: DEFAULT_TEMPLATE_NAME, version: 1 };
}

/**
 * The template ONE visit's note is read and written under: the version the
 * visit is pinned to, else the org's active one.
 *
 * Every per-visit reader and writer in this file resolves through here, and
 * the COALESCE is the one the note preview and audit packet
 * (audit-packet.service.ts), the sign guard (visit.service.ts) and the payer
 * documentation check use. The editor used to read the ACTIVE template
 * instead, so once an org edited its template a note written under v1 showed
 * v2's sections in the editor and v1's in the preview, and the editor's
 * "still required" list could disagree with what actually blocked signing.
 */
export async function resolveVisitNoteTemplate(
  tx: Tx,
  args: { orgId: string; visitId: string },
): Promise<NoteTemplateRef> {
  // Ensured first so an unpinned visit always has an active version to fall
  // back to: the shipped default, on an org's very first note.
  await activeTemplate(tx, { orgId: args.orgId });
  // The visit and the template are both named by org, as well as left to RLS.
  const rows = await tx.$queryRaw<NoteTemplateRef[]>`
    SELECT tpl.id, tpl.name, tpl.version
      FROM note_template tpl
     WHERE tpl.id = COALESCE(
             (SELECT note_template_id FROM visit
               WHERE id = ${args.visitId}::uuid AND org_id = ${args.orgId}::uuid),
             (SELECT nt.id FROM note_template nt
               WHERE nt.org_id = ${args.orgId}::uuid AND nt.is_active LIMIT 1))
       AND tpl.org_id = ${args.orgId}::uuid
     LIMIT 1
  `;
  // With an active version ensured above, no row means the visit is pinned to
  // a template this org cannot see. The foreign key rules that out for real
  // data, so it is a bug here (the two binds out of order, a cross-org pin).
  // Falling back to the active version would quietly show and validate the
  // note against sections it was not written under, which is the failure the
  // pin exists to prevent, so this fails loudly (a 500) instead.
  const resolved = rows[0];
  if (!resolved) {
    throw new Error(`Note template for visit ${args.visitId} did not resolve.`);
  }
  return resolved;
}

export interface TemplateSectionInput {
  sectionKey: string;
  label: string;
  helpText: string | null;
  kind: NoteSectionKind;
  isRequired: boolean;
  notRequiredForVisitTypes: string[];
}

/** The org's active template, as the settings screen edits it. */
export async function getNoteTemplateForEditing(args: {
  orgId: string;
}): Promise<{
  templateId: string;
  name: string;
  version: number;
  source: string;
  sections: TemplateSectionInput[];
}> {
  const template = await ensureNoteTemplate({ orgId: args.orgId });
  return withOrgContext(args.orgId, async (tx) => {
    const meta = await tx.$queryRaw<{ source: string }[]>`
      SELECT source FROM note_template
       WHERE id = ${template.id}::uuid AND org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    const rows = await tx.$queryRaw<
      {
        section_key: string; label: string; help_text: string | null;
        kind: NoteSectionKind; is_required: boolean;
        not_required_for_visit_types: string[] | null;
      }[]
    >`
      SELECT section_key, label, help_text, kind, is_required, not_required_for_visit_types
        FROM note_template_section
       WHERE template_id = ${template.id}::uuid
         AND org_id = ${args.orgId}::uuid
       ORDER BY sort_order
    `;
    return {
      templateId: template.id,
      name: template.name,
      version: template.version,
      source: meta[0]?.source ?? "default",
      sections: rows.map((r) => ({
        sectionKey: r.section_key,
        label: r.label,
        helpText: r.help_text,
        kind: r.kind,
        isRequired: r.is_required,
        notRequiredForVisitTypes: r.not_required_for_visit_types ?? [],
      })),
    };
  });
}

/**
 * Replace the org's template with a new VERSION.
 *
 * Mark, handing over The Perfect Note [05:55]: "I developed it over eight years
 * ago. It's not quite current to current technology and current rules, but
 * it'll give you an idea." A starting point an org cannot change is not a
 * starting point, it is an authority — and the shipped set was exactly that,
 * because nothing in the product ever wrote note_template_section.
 *
 * A new row, not an UPDATE. visit.note_template_id pins each visit to the
 * version its note was written under, so rewriting labels in place would
 * silently restate what an already-signed note said its sections were. The old
 * version is deactivated and kept.
 */
export async function saveNoteTemplate(args: {
  orgId: string;
  userId?: string;
  name?: string;
  sections: TemplateSectionInput[];
}): Promise<{ templateId: string; version: number }> {
  const current = await ensureNoteTemplate({ orgId: args.orgId });

  if (args.sections.length === 0) {
    throw new ValidationError("A note template needs at least one section.");
  }
  const keys = args.sections.map((s) => s.sectionKey);
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) {
    throw new ValidationError(`Section key "${dupe}" appears more than once.`);
  }
  for (const s of args.sections) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(s.sectionKey)) {
      throw new ValidationError(
        `"${s.sectionKey}" is not a valid section key. Use lower-case letters, digits and underscores.`,
      );
    }
    if (s.label.trim() === "") {
      throw new ValidationError(`Section "${s.sectionKey}" needs a label.`);
    }
  }
  // More than one vitals section would give the sign guard two things to check
  // against one visit_vitals row.
  if (args.sections.filter((s) => s.kind === "vitals").length > 1) {
    throw new ValidationError("A template can hold only one vitals section.");
  }

  return withOrgContext(args.orgId, async (tx) => {
    const next = await tx.$queryRaw<{ v: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS v FROM note_template
       WHERE org_id = ${args.orgId}::uuid
    `;
    const version = Number(next[0]?.v ?? 1);

    // Deactivate first: note_template_one_active_per_org is a unique partial
    // index, so inserting a second active row would violate it.
    await tx.$executeRaw`
      UPDATE note_template SET is_active = FALSE
       WHERE org_id = ${args.orgId}::uuid AND is_active
    `;

    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO note_template (org_id, name, version, is_active, source, created_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.name?.trim() || current.name}, ${version}, TRUE,
              'edited', ${args.userId ?? null}::uuid)
      RETURNING id
    `;
    const templateId = created[0]!.id;

    for (const [i, s] of args.sections.entries()) {
      await tx.$executeRaw`
        INSERT INTO note_template_section
          (org_id, template_id, section_key, label, help_text, kind, is_required,
           not_required_for_visit_types, sort_order)
        VALUES (${args.orgId}::uuid, ${templateId}::uuid, ${s.sectionKey}, ${s.label.trim()},
                ${s.helpText?.trim() || null}, ${s.kind}, ${s.isRequired},
                ${s.notRequiredForVisitTypes ?? []}::text[], ${i})
      `;
    }

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "note_template_edit",
      targetType: "note_template",
      targetId: templateId,
      payload: {
        version,
        supersededVersion: current.version,
        sectionKeys: args.sections.map((s) => s.sectionKey),
        requiredKeys: args.sections.filter((s) => s.isRequired).map((s) => s.sectionKey),
      },
    });

    return { templateId, version };
  });
}

/** The whole note for one visit: every section its template version declares, plus content. */
export async function getVisitNote(args: {
  orgId: string;
  visitId: string;
}): Promise<VisitNoteView> {
  return withOrgContext(args.orgId, async (tx) => {
    // The visit's own template version, not the org's current one, so the
    // editor lists exactly the sections the preview, the audit packet and the
    // sign guard judge this note by.
    const template = await resolveVisitNoteTemplate(tx, args);

    const rows = await tx.$queryRaw<
      {
        section_key: string;
        label: string;
        help_text: string | null;
        kind: NoteSectionKind;
        is_required: boolean;
        not_required_for_visit_types: string[] | null;
        sort_order: number;
        content: unknown;
        is_empty: boolean | null;
        carried_from_visit_id: string | null;
        carried_unchanged: boolean | null;
        updated_at: Date | null;
      }[]
    >`
      SELECT t.section_key, t.label, t.help_text, t.kind, t.is_required,
             t.not_required_for_visit_types, t.sort_order,
             s.content, s.is_empty, s.carried_from_visit_id, s.carried_unchanged,
             s.updated_at
        FROM note_template_section t
        LEFT JOIN visit_note_section s
               ON s.visit_id = ${args.visitId}::uuid
              AND s.section_key = t.section_key
       WHERE t.template_id = ${template.id}::uuid
       ORDER BY t.sort_order
    `;

    // Requiredness depends on the visit type: there is no physical exam on a
    // telehealth call and no patient to examine at a bereavement follow-up.
    // Telehealth is the visit's own flag, not a type (audit R22), so it is
    // read too — a video visit on any type gets the telehealth exemptions.
    const vt = await tx.$queryRaw<{ visit_type: string | null; is_telehealth: boolean | null }[]>`
      SELECT visit_type, is_telehealth FROM visit WHERE id = ${args.visitId}::uuid LIMIT 1
    `;
    const visitType = vt[0]?.visit_type ?? null;
    const isTelehealth = vt[0]?.is_telehealth === true;

    const v = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT height_cm, weight_kg, bp_systolic, bp_diastolic, heart_rate, resp_rate,
             temperature_c, spo2_percent, pps_percent, pain_score, notes, recorded_at
        FROM visit_vitals WHERE visit_id = ${args.visitId}::uuid LIMIT 1
    `;
    const vitals = v[0] ? rowToVitals(v[0]) : null;
    // Measurements only, the sign guard's num_nonnulls rule (visit.service.ts).
    // Counting the free-text note too let a row holding only "declined
    // weight" clear the vitals section here while the guard still refused the
    // signature for it.
    const vitalsPresent = vitals !== null && hasAnyMeasurement(vitals);

    const sections: NoteSectionView[] = rows.map((r) => ({
      sectionKey: r.section_key,
      label: r.label,
      helpText: r.help_text,
      kind: r.kind,
      // The EFFECTIVE requiredness for this visit, so the chip the clinician
      // sees and the rule that blocks the signature are the same fact.
      isRequired: sectionIsRequiredFor(
        {
          isRequired: r.is_required,
          notRequiredForVisitTypes: r.not_required_for_visit_types,
        },
        visitType,
        isTelehealth,
      ),
      sortOrder: r.sort_order,
      content: r.content ?? null,
      // A vitals section is judged by visit_vitals, never by its own content.
      isEmpty: r.kind === "vitals" ? !vitalsPresent : (r.is_empty ?? true),
      carriedFromVisitId: r.carried_from_visit_id,
      carriedUnchanged: r.carried_unchanged ?? false,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));

    return {
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      sections,
      vitals,
      missingRequired: sections
        .filter((s) => s.isRequired && s.isEmpty)
        .map((s) => ({ sectionKey: s.sectionKey, label: s.label })),
    };
  });
}

/** Write one section. Refuses once the visit is signed — the note is attested. */
export async function saveNoteSection(args: {
  orgId: string;
  visitId: string;
  sectionKey: string;
  content: unknown;
  userId?: string;
}): Promise<{ updated: boolean; isEmpty: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const visit = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM visit WHERE id = ${args.visitId}::uuid LIMIT 1
    `;
    if (!visit[0]) throw new NotFoundError("Visit not found.");
    if (["documented", "pending_billing", "billed"].includes(visit[0].status)) {
      throw new ValidationError(
        "This visit is signed and submitted. Record any change as a new addendum rather than editing an attested note.",
      );
    }

    // Validated against the visit's own template version. A note started
    // under v1 keeps accepting v1's sections after the org moves to v2, and
    // refuses a section only v2 declares: this note's editor, preview and
    // sign guard would never show it.
    const template = await resolveVisitNoteTemplate(tx, args);

    const def = await tx.$queryRaw<{ kind: NoteSectionKind }[]>`
      SELECT kind FROM note_template_section
       WHERE template_id = ${template.id}::uuid AND section_key = ${args.sectionKey}
       LIMIT 1
    `;
    if (!def[0]) {
      throw new ValidationError(
        `"${args.sectionKey}" is not a section of this org's note template version ${template.version}, the version this visit's note is written under.`,
      );
    }
    if (def[0].kind === "vitals") {
      throw new ValidationError("Vitals are saved through the vitals endpoint.");
    }

    const isEmpty = sectionContentIsEmpty(def[0].kind, args.content);
    const json = JSON.stringify(args.content ?? {});

    await tx.$executeRaw`
      INSERT INTO visit_note_section
        (org_id, visit_id, section_key, content, is_empty, updated_at, updated_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.visitId}::uuid, ${args.sectionKey},
              ${json}::jsonb, ${isEmpty}, now(), ${args.userId ?? null}::uuid)
      ON CONFLICT (visit_id, section_key) DO UPDATE
        SET content = EXCLUDED.content,
            is_empty = EXCLUDED.is_empty,
            -- The clinician has now typed in this section, so it is no longer
            -- carried forward unchanged. carried_from_visit_id is kept: where
            -- the text started is still true and still worth an auditor seeing.
            carried_unchanged = FALSE,
            updated_at = now(),
            updated_by_user_id = EXCLUDED.updated_by_user_id
    `;

    // Keep the visit row in step so the sign guard, and everything still
    // reading document_text, agree with the sections.
    //
    // The pin is set once and never moved: COALESCE keeps a pin the visit
    // already has, so a note stays on the version it was first written under
    // however often the org edits its template. An unpinned visit takes the
    // version the key was just validated against rather than a fresh read of
    // the active one, so a template edit landing mid-save cannot pin it to a
    // version that lacks the section it just wrote.
    await tx.$executeRaw`
      UPDATE visit
         SET note_template_id = COALESCE(note_template_id, ${template.id}::uuid),
             status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END,
             updated_at = now()
       WHERE id = ${args.visitId}::uuid
    `;
    return { updated: true, isEmpty };
  });
}

/** Record this visit's vitals. One row per visit — a correction updates it. */
export async function saveVitals(args: {
  orgId: string;
  visitId: string;
  vitals: Partial<Omit<VitalsView, "recordedAt">>;
  userId?: string;
}): Promise<{ updated: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const visit = await tx.$queryRaw<{ status: string; patient_id: string }[]>`
      SELECT status, patient_id FROM visit WHERE id = ${args.visitId}::uuid LIMIT 1
    `;
    if (!visit[0]) throw new NotFoundError("Visit not found.");
    if (["documented", "pending_billing", "billed"].includes(visit[0].status)) {
      throw new ValidationError(
        "This visit is signed and submitted. Record any change as a new addendum rather than editing an attested note.",
      );
    }

    const v = args.vitals;
    await tx.$executeRaw`
      INSERT INTO visit_vitals
        (org_id, visit_id, patient_id, height_cm, weight_kg, bp_systolic, bp_diastolic,
         heart_rate, resp_rate, temperature_c, spo2_percent, pps_percent, pain_score,
         notes, created_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.visitId}::uuid, ${visit[0].patient_id}::uuid,
              ${v.heightCm ?? null}, ${v.weightKg ?? null}, ${v.bpSystolic ?? null},
              ${v.bpDiastolic ?? null}, ${v.heartRate ?? null}, ${v.respRate ?? null},
              ${v.temperatureC ?? null}, ${v.spo2Percent ?? null}, ${v.ppsPercent ?? null},
              ${v.painScore ?? null}, ${v.notes ?? null}, ${args.userId ?? null}::uuid)
      ON CONFLICT (visit_id) DO UPDATE
        SET height_cm = EXCLUDED.height_cm, weight_kg = EXCLUDED.weight_kg,
            bp_systolic = EXCLUDED.bp_systolic, bp_diastolic = EXCLUDED.bp_diastolic,
            heart_rate = EXCLUDED.heart_rate, resp_rate = EXCLUDED.resp_rate,
            temperature_c = EXCLUDED.temperature_c, spo2_percent = EXCLUDED.spo2_percent,
            pps_percent = EXCLUDED.pps_percent, pain_score = EXCLUDED.pain_score,
            notes = EXCLUDED.notes, recorded_at = now()
    `;

    // Recording vitals starts a note as surely as typing a section does, so it
    // pins the visit the same way, with the same set-once COALESCE. Unpinned,
    // a vitals-only note followed the org's active template, and a template
    // edit could reshape a note somebody had already begun.
    //
    // It starts the VISIT too, with the bump every sibling writer carries
    // (saveNoteSection, carryForwardSections, documentVisit). Without it a
    // nurse could open a scheduled visit, weigh the patient and tab out, and
    // the visit would still sit under "Scheduled" on /visits with an
    // updated_at from the day it was booked — the screen the round is worked
    // from saying nobody had been yet.
    const template = await resolveVisitNoteTemplate(tx, args);
    await tx.$executeRaw`
      UPDATE visit
         SET note_template_id = COALESCE(note_template_id, ${template.id}::uuid),
             status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END,
             updated_at = now()
       WHERE id = ${args.visitId}::uuid
    `;

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "visit_vitals_record",
      targetType: "visit",
      targetId: args.visitId,
      payload: { fields: Object.keys(v).filter((k) => v[k as keyof typeof v] != null) },
    });
    return { updated: true };
  });
}

export interface VitalsTrendRow extends VitalsView {
  visitId: string;
  /** The visit's day where the practice is, 'YYYY-MM-DD' (0107). */
  dateOfService: string | null;
}

export interface VitalsTrendView {
  /** Newest first. One capped page of the history, not the history. */
  rows: VitalsTrendRow[];
  /**
   * Every visit with vitals on file for this patient, however many came back
   * in `rows`. What lets a caller label a capped page as a page — the chart's
   * "Latest 200 of 206" — rather than presenting it as the whole record.
   */
  total: number;
}

/**
 * The longitudinal read Mark asked for — "keep track of their vitals, their
 * weight". Newest first: one capped page, and how many readings exist in all.
 *
 * The cap stays. What was wrong was the silence around it: ORDER BY dos DESC
 * LIMIT 50 drops the OLDEST readings, and those are the baseline a palliative
 * weight loss is measured FROM — the "160 pounds" in "weight loss from 160
 * pounds to a current 128 pounds". A patient seen weekly for 14 months has
 * ~60 rows, so the ten that carry the 160 fell off the end while the screen
 * labelled the 50 it kept as the whole record. The total comes back with the
 * rows so the copy can tell the truth, the way the billing queues already do
 * (audit R34).
 *
 * Saying so was not enough on its own: "Latest 50 of 61" is honest and still
 * leaves the 160 off the screen. The chart route asks for `limit: 200` — the
 * ceiling clamped below — so the default of 50 now only ever applies to a
 * caller that wants a short page.
 */
export async function getVitalsTrend(args: {
  orgId: string;
  patientId: string;
  limit?: number;
}): Promise<VitalsTrendView> {
  return withOrgContext(args.orgId, async (tx) => {
    // Ordered by DATE OF SERVICE, not recorded_at.
    //
    // recorded_at is when somebody typed the numbers in. Palliative notes are
    // routinely written up in the evening, several visits at a time, so
    // ordering by it puts the trend in data-entry order and labels a weight
    // loss with the date of the typing rather than the encounter. The x-axis
    // of a clinical trend is when the patient was seen.
    //
    // The date shown is the visit's day where the practice is (0107). This
    // returned the instant, and the chart sliced its UTC day: an 8:30 pm Ohio
    // visit on the 22nd read as the 23rd. The org is named as well as relied on
    // through RLS, and the visit is joined within the vitals row's org.
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT vv.visit_id, vv.height_cm, vv.weight_kg, vv.bp_systolic, vv.bp_diastolic,
             vv.heart_rate, vv.resp_rate, vv.temperature_c, vv.spo2_percent,
             vv.pps_percent, vv.pain_score, vv.notes, vv.recorded_at,
             (COALESCE(v.start_time, v.scheduled_start, vv.recorded_at) AT TIME ZONE o.timezone)::date
               AS dos_day
        FROM visit_vitals vv
        JOIN visit v ON v.id = vv.visit_id AND v.org_id = vv.org_id
        JOIN org o ON o.id = vv.org_id
       WHERE vv.patient_id = ${args.patientId}::uuid
         AND vv.org_id = ${args.orgId}::uuid
       ORDER BY COALESCE(v.start_time, v.scheduled_start, vv.recorded_at) DESC
       LIMIT ${Math.min(args.limit ?? 50, 200)}
    `;

    // The same FROM and the same predicate as the page above, deliberately. A
    // total counted over a wider set than the rows are drawn from would be a
    // fresh untruth in place of the old one: a vitals row whose visit has gone
    // is not a visit with recorded vitals. Counting one would relabel a
    // complete "61 visits" as "Latest 61 of 62" — a cap that is not there.
    const counted = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n
        FROM visit_vitals vv
        JOIN visit v ON v.id = vv.visit_id AND v.org_id = vv.org_id
        JOIN org o ON o.id = vv.org_id
       WHERE vv.patient_id = ${args.patientId}::uuid
         AND vv.org_id = ${args.orgId}::uuid
    `;

    return {
      rows: rows.map((r) => ({
        ...rowToVitals(r),
        visitId: String(r.visit_id),
        // A DATE: Prisma returns it at UTC midnight, so its UTC day is the day.
        dateOfService: r.dos_day instanceof Date ? dateColumnIso(r.dos_day) : null,
      })),
      total: Number(counted[0]?.n ?? 0),
    };
  });
}

export interface CarryForwardSource {
  visitId: string;
  visitDate: string | null;
  visitTypeLabel: string | null;
  /** Sections on that visit that hold something worth bringing forward. */
  sections: { sectionKey: string; label: string }[];
}

/**
 * The most recent SIGNED visit for the same patient, and what its note holds.
 *
 * Signed only, deliberately. An unsigned visit is a draft somebody may still be
 * mid-way through; carrying a half-written paragraph into the next encounter
 * would propagate work nobody attested to.
 */
export async function getCarryForwardSource(args: {
  orgId: string;
  visitId: string;
}): Promise<CarryForwardSource | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const prev = await tx.$queryRaw<
      { id: string; dos: Date | null; label: string | null }[]
    >`
      SELECT p.id,
             COALESCE(p.start_time, p.scheduled_start) AS dos,
             t.label
        FROM visit cur
        JOIN visit p
          ON p.patient_id = cur.patient_id
         AND p.id <> cur.id
         AND p.status IN ('documented', 'pending_billing', 'billed')
         -- Earlier ENCOUNTER, not merely the most recently signed one.
         -- Palliative notes are often written up days late, so ordering by
         -- signed_at alone would offer to carry a later visit's findings
         -- backwards into an earlier note. An auditor reading a note that
         -- describes a state the patient had not reached yet is exactly the
         -- documentation failure carry-forward provenance exists to expose.
         AND COALESCE(p.start_time, p.scheduled_start)
             < COALESCE(cur.start_time, cur.scheduled_start, now())
        LEFT JOIN org_visit_type t
          ON t.slug = p.visit_type AND t.org_id = p.org_id
       WHERE cur.id = ${args.visitId}::uuid
       ORDER BY COALESCE(p.signed_at, p.start_time, p.scheduled_start) DESC
       LIMIT 1
    `;
    if (!prev[0]) return null;

    // Offered and labelled through THIS visit's template version. A section it
    // does not declare would land where neither this note's editor nor its
    // preview shows it, so it is not offered at all.
    const template = await resolveVisitNoteTemplate(tx, args);

    const sections = await tx.$queryRaw<{ section_key: string; label: string }[]>`
      SELECT s.section_key, t.label
        FROM visit_note_section s
        JOIN note_template_section t
          ON t.section_key = s.section_key AND t.template_id = ${template.id}::uuid
       WHERE s.visit_id = ${prev[0].id}::uuid AND NOT s.is_empty
       ORDER BY t.sort_order
    `;

    return {
      visitId: prev[0].id,
      visitDate: prev[0].dos ? new Date(prev[0].dos).toISOString() : null,
      visitTypeLabel: prev[0].label,
      sections: sections.map((s) => ({ sectionKey: s.section_key, label: s.label })),
    };
  });
}

/**
 * Copy chosen sections from the previous signed visit into this one.
 *
 * Only fills sections that are currently EMPTY here. Carrying forward must
 * never silently replace something the clinician has already written on this
 * encounter, and "I brought forward the history but wrote today's exam myself"
 * is the normal, correct shape of a follow-up note.
 */
export async function carryForwardSections(args: {
  orgId: string;
  visitId: string;
  fromVisitId: string;
  sectionKeys: string[];
  userId?: string;
}): Promise<{ copied: string[]; skipped: string[] }> {
  return withOrgContext(args.orgId, async (tx) => {
    const visit = await tx.$queryRaw<{ status: string; patient_id: string }[]>`
      SELECT status, patient_id FROM visit WHERE id = ${args.visitId}::uuid LIMIT 1
    `;
    if (!visit[0]) throw new NotFoundError("Visit not found.");
    if (["documented", "pending_billing", "billed"].includes(visit[0].status)) {
      throw new ValidationError(
        "This visit is signed. Record any change as a new addendum rather than editing an attested note.",
      );
    }

    // The source must be the same patient, in this org, and signed — otherwise
    // this is a route to copy one patient's history onto another.
    const src = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visit
       WHERE id = ${args.fromVisitId}::uuid
         AND patient_id = ${visit[0].patient_id}::uuid
         AND status IN ('documented', 'pending_billing', 'billed')
       LIMIT 1
    `;
    if (!src[0]) {
      throw new ValidationError(
        "That visit is not a signed visit for this patient, so its note cannot be carried forward.",
      );
    }

    // The same resolution the editor reads through. A key this visit's
    // template does not declare is skipped rather than copied: its text would
    // sit in a section no editor or preview of this visit shows, yet still
    // count as documentation wherever filled rows are counted.
    const template = await resolveVisitNoteTemplate(tx, args);

    const copied: string[] = [];
    const skipped: string[] = [];
    for (const key of args.sectionKeys) {
      const n = await tx.$executeRaw`
        INSERT INTO visit_note_section
          (org_id, visit_id, section_key, content, is_empty,
           carried_from_visit_id, carried_unchanged, updated_at, updated_by_user_id)
        SELECT ${args.orgId}::uuid, ${args.visitId}::uuid, s.section_key,
               s.content, FALSE, ${args.fromVisitId}::uuid, TRUE, now(),
               ${args.userId ?? null}::uuid
          FROM visit_note_section s
          JOIN note_template_section d
            ON d.section_key = s.section_key AND d.template_id = ${template.id}::uuid
         WHERE s.visit_id = ${args.fromVisitId}::uuid
           AND s.section_key = ${key}
           AND NOT s.is_empty
        ON CONFLICT (visit_id, section_key) DO UPDATE
          SET content = EXCLUDED.content,
              is_empty = FALSE,
              carried_from_visit_id = EXCLUDED.carried_from_visit_id,
              carried_unchanged = TRUE,
              updated_at = now(),
              updated_by_user_id = EXCLUDED.updated_by_user_id
          -- Never overwrite work already done on THIS visit.
          WHERE visit_note_section.is_empty
      `;
      (n > 0 ? copied : skipped).push(key);
    }

    // A note first written by carry-forward is pinned the way saveNoteSection
    // pins one first typed into, so it too keeps the version it was started
    // under when the org edits its template; otherwise a carried section the
    // new version drops would vanish from the editor and the preview. Nothing
    // copied means nothing written, so a NULL leaves the pin as it was.
    await tx.$executeRaw`
      UPDATE visit SET updated_at = now(),
             note_template_id = COALESCE(note_template_id,
                                         ${copied.length > 0 ? template.id : null}::uuid),
             status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END
       WHERE id = ${args.visitId}::uuid
    `;

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "visit_note_carry_forward",
      targetType: "visit",
      targetId: args.visitId,
      payload: { fromVisitId: args.fromVisitId, copied, skipped },
    });

    return { copied, skipped };
  });
}

/** Does this visit's structured note carry anything at all? */
export async function noteHasContent(args: {
  orgId: string;
  visitId: string;
}): Promise<boolean> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM visit_note_section
       WHERE visit_id = ${args.visitId}::uuid AND NOT is_empty
    `;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    const v = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT height_cm, weight_kg, bp_systolic, bp_diastolic, heart_rate, resp_rate,
             temperature_c, spo2_percent, pps_percent, pain_score, notes, recorded_at
        FROM visit_vitals WHERE visit_id = ${args.visitId}::uuid LIMIT 1
    `;
    return v[0] ? hasAnyReading(rowToVitals(v[0])) : false;
  });
}

const num = (x: unknown): number | null =>
  x === null || x === undefined ? null : Number(x);

function rowToVitals(r: Record<string, unknown>): VitalsView {
  return {
    heightCm: num(r.height_cm),
    weightKg: num(r.weight_kg),
    bpSystolic: num(r.bp_systolic),
    bpDiastolic: num(r.bp_diastolic),
    heartRate: num(r.heart_rate),
    respRate: num(r.resp_rate),
    temperatureC: num(r.temperature_c),
    spo2Percent: num(r.spo2_percent),
    ppsPercent: num(r.pps_percent),
    painScore: num(r.pain_score),
    notes: (r.notes as string | null) ?? null,
    recordedAt: r.recorded_at ? new Date(r.recorded_at as string).toISOString() : null,
  };
}

/**
 * At least one measurement. The rule for "is the vitals section filled":
 * the same ten columns the sign guard's num_nonnulls counts, and nothing else.
 */
export function hasAnyMeasurement(v: VitalsView): boolean {
  return [
    v.heightCm, v.weightKg, v.bpSystolic, v.bpDiastolic, v.heartRate,
    v.respRate, v.temperatureC, v.spo2Percent, v.ppsPercent, v.painScore,
  ].some((x) => x !== null);
}

/**
 * A vitals row exists but every reading is null — that is not documentation.
 * Wider than hasAnyMeasurement: a note like "declined weight" is something
 * written on the visit, so it counts as content, but it is not a vital sign
 * and does not fill a required vitals section.
 */
export function hasAnyReading(v: VitalsView): boolean {
  return hasAnyMeasurement(v) || (v.notes ?? "").trim() !== "";
}

export { EMPTY_VITALS };
