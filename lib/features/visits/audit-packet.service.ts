/**
 * The audit packet: one visit's note and its superbill, in one document, with
 * the comparison an auditor actually performs already done.
 *
 * Mark Hendrix, 20 Aug 2026 [10:12]: "they're going to want to take the note and
 * then they want to take the superbill and compare them and make sure that they
 * match." [10:48] "the audit tool that you need for each visit is that note and
 * — and the superbill." [10:27] the failure he describes is agencies who "cheat,
 * or fall, or break the rules and don't realize it — because the two are not
 * linked together."
 *
 * He then told us Pallio had already solved this — "you've actually got it
 * linked together really well, much better than most EMRs" — while looking at a
 * platform-admin org table, from memory. It had not. The note reached no export,
 * no claim and no packet, and the superbill could be edited away from the
 * attested note with nothing noticing.
 *
 * So this does not just staple two documents together. It renders the note, the
 * bill, and a RECONCILIATION section that states plainly where they disagree —
 * because a packet that hides a mismatch is worse than no packet: it launders
 * the problem into a document that looks authoritative.
 */
import puppeteer, { type Browser } from "puppeteer";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { formatCodes, sameAssignment, type CodeUnits } from "@/lib/features/billing/code-units";
import { orgLocalDate, orgToday } from "@/lib/features/org/org-date";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import {
  careTeamHeaderRows,
  escapeHtml,
  renderAddendaHtml,
  renderAttestationLine,
  renderNoteBodyHtml,
  renderSectionHtml,
  renderVitalsRows,
  type HeaderContact,
  type HeaderProvider,
  type HeaderRow,
} from "./note-render";
import { documentationFindings } from "./documentation-check";
import { loadDocumentationGaps, type DocumentationGaps } from "./documentation-check.service";
import { posLabel } from "./place-of-service";

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

export interface PacketFinding {
  severity: "match" | "attention" | "mismatch";
  label: string;
  detail: string;
  /**
   * Something the reader can do about this finding, as a stable key rather
   * than display text, so the screen never has to match on wording. The PDF
   * ignores it — an auditor's copy offers no actions.
   */
  action?: "create_superbill";
}

interface PacketData {
  visit: {
    id: string;
    status: string;
    dos: Date | null;
    total_minutes: number | null;
    acp_minutes: number | null;
    is_telehealth: boolean;
    telehealth_modality: string | null;
    cpt_codes_assigned: string[] | null;
    /**
     * Units per code when more than one (0106); {} = one each. Optional, so a
     * hand-built PacketData needs none.
     */
    cpt_units?: CodeUnits | null;
    icd10_codes: string[] | null;
    modifiers: string[] | null;
    signed_at: Date | null;
    visit_type_label: string | null;
    /**
     * The band the visit's type bills as; 'non_billable' means no bill is due
     * (audit R18). Optional, so a hand-built PacketData needs none.
     */
    coding_basis?: string | null;
    /** Where the visit took place (audit R23); NULL on visits before 0095. */
    place_of_service_code: string | null;
    signer_name: string | null;
    signer_email: string | null;
    clinician_name: string | null;
    clinician_user_id: string | null;
    signed_by_user_id: string | null;
    /** The credential the signer attested under, snapshotted at sign-off (R32). */
    signer_credential: string | null;
  };
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    date_of_birth: Date;
    primary_member_id: string | null;
    /** The patient's primary NP, who heads the care-team header (audit R30). */
    palliative_provider_name?: string | null;
  };
  /**
   * The care-team header (audit R30): outside providers and the POA and
   * primary caregiver, as on file now, not as at signing. Optional, so a
   * hand-built PacketData needs none.
   */
  careTeam?: HeaderRow[];
  sections: {
    label: string;
    kind: "prose" | "list" | "vitals";
    content: unknown;
    is_empty: boolean;
    carried_unchanged: boolean;
  }[];
  vitals: Record<string, unknown> | null;
  superbill: {
    id: string;
    status: string;
    cpt_codes: string[];
    /** Units per code as billed (0106); optional, as on the visit. */
    cpt_units?: CodeUnits | null;
    icd10_codes: string[];
    modifiers: string[] | null;
    billed_amount_cents: bigint;
    provider_npi: string;
    provider_name: string;
    /** NULL on bills saved before 0092. */
    billing_npi: string | null;
    place_of_service_code: string | null;
    payer_name: string | null;
    member_id_snapshot: string;
  } | null;
  /** Corrections signed after the note (audit R15), in order. */
  addenda: {
    body: string;
    author_name: string | null;
    author_credential: string | null;
    signed_at: Date;
  }[];
  /**
   * The payer's documentation standard against this note (audit R19).
   * Optional, so a hand-built PacketData (the reconcile tests) needs none.
   */
  documentation?: DocumentationGaps;
  orgName: string;
  /**
   * org.timezone (0107): the visit's date, the addenda's and the export's are
   * the practice's days in it, never the instant's UTC day.
   */
  timeZone: string;
  primary: string;
}

/**
 * The reconciliation on its own — no PDF, no export.
 *
 * The findings were being computed and then discarded: the route destructured
 * only the PDF bytes, so a clinician could learn that their note and their
 * claim disagree ONLY by downloading a document they have no permission to
 * download. That is the check Mark cares most about [10:12] — "take the note
 * and take the Superbill and compare them and make sure that they match" —
 * and it was reaching nobody.
 *
 * Deliberately NOT gated on the export permission, and deliberately not
 * logged as a PHI export, because it is neither: it returns short factual
 * statements about a visit the caller can already read, and no document
 * leaves the system. The PDF remains a disclosure and stays gated.
 *
 * Works before signing too. generateAuditPacketPdf refuses an unsigned visit
 * because an auditor would never be handed one, but the whole value of this
 * to a clinician is seeing the disagreement while the note can still be fixed.
 */
export async function getVisitReconciliation(args: {
  orgId: string;
  visitId: string;
}): Promise<{ findings: PacketFinding[]; status: string; hasSuperbill: boolean }> {
  const d = await load(args.orgId, args.visitId);
  return {
    findings: reconcile(d),
    status: d.visit.status,
    hasSuperbill: d.superbill !== null,
  };
}

export async function generateAuditPacketPdf(args: {
  orgId: string;
  userId: string;
  visitId: string;
}): Promise<{ pdfBytes: Buffer; patientId: string; findings: PacketFinding[] }> {
  const d = await load(args.orgId, args.visitId);

  // An unsigned visit has no attested note, so there is nothing to defend a
  // claim with and nothing an auditor would be given.
  if (!["documented", "pending_billing", "billed"].includes(d.visit.status)) {
    throw new ValidationError(
      `This visit is ${d.visit.status}. An audit packet is only meaningful once the note has been signed.`,
    );
  }

  const findings = reconcile(d);
  const html = renderHtml(d, findings);

  const browser = await getBrowser();
  const page = await browser.newPage();
  let pdfBytes: Buffer;
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const result = await page.pdf({
      format: "Letter",
      margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="font-size:8px;color:#64748b;width:100%;padding:0 0.6in;display:flex;justify-content:space-between;">' +
        `<span>${escapeHtml(d.patient.last_name)}, ${escapeHtml(d.patient.first_name)} · visit ${escapeHtml(d.visit.id.slice(0, 8))}${d.patient.primary_member_id ? ` · Member ${escapeHtml(d.patient.primary_member_id)}` : ""}</span>` +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
    pdfBytes = Buffer.from(result);
  } finally {
    await page.close();
  }

  void logPhiExport({
    orgId: args.orgId,
    userId: args.userId,
    exportType: "visit_audit_packet",
    patientIds: [d.patient.id],
    byteSize: pdfBytes.byteLength,
  });

  return { pdfBytes, patientId: d.patient.id, findings };
}

/**
 * Every read below names the org as well as leaning on RLS: on a connection
 * that bypasses RLS the visit id alone opened another org's chart, and the
 * packet printed their patient, note and bill under this org's letterhead.
 */
async function load(orgId: string, visitId: string): Promise<PacketData> {
  return withOrgContext(orgId, async (tx) => {
    const v = await tx.$queryRaw<PacketData["visit"][]>`
      SELECT v.id, v.status,
             COALESCE(v.start_time, v.scheduled_start) AS dos,
             v.total_minutes, v.acp_minutes, v.is_telehealth, v.telehealth_modality,
             v.cpt_codes_assigned, v.cpt_units, v.icd10_codes, v.modifiers, v.signed_at,
             v.place_of_service_code,
             t.label AS visit_type_label, t.coding_basis,
             su.full_name AS signer_name, su.email AS signer_email,
             cu.full_name AS clinician_name,
             v.clinician_user_id, v.signed_by_user_id, v.signer_credential
        FROM visit v
        LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
        LEFT JOIN app_user su ON su.id = v.signed_by_user_id
        LEFT JOIN app_user cu ON cu.id = v.clinician_user_id
       WHERE v.id = ${visitId}::uuid
         AND v.org_id = ${orgId}::uuid
       LIMIT 1
    `;
    if (!v[0]) throw new NotFoundError("Visit not found.");

    const p = await tx.$queryRaw<PacketData["patient"][]>`
      SELECT pt.id, pt.first_name, pt.last_name, pt.date_of_birth, pt.primary_member_id,
             np.full_name AS palliative_provider_name
        FROM visit v JOIN patient pt ON pt.id = v.patient_id AND pt.org_id = v.org_id
        LEFT JOIN app_user np ON np.id = pt.primary_np_user_id
       WHERE v.id = ${visitId}::uuid AND v.org_id = ${orgId}::uuid LIMIT 1
    `;

    const sections = await tx.$queryRaw<PacketData["sections"]>`
      SELECT t.label, t.kind, s.content,
             COALESCE(s.is_empty, TRUE) AS is_empty,
             COALESCE(s.carried_unchanged, FALSE) AS carried_unchanged
        FROM note_template_section t
        LEFT JOIN visit_note_section s
               ON s.visit_id = ${visitId}::uuid AND s.section_key = t.section_key
              AND s.org_id = t.org_id
       -- The visit's pin, else the org's active template. The pin
       -- (note_template_id) is the version the note was started under, set
       -- by saving a section, carry-forward, recording vitals, and sign-off;
       -- a visit without one has nothing in its structured note yet. Joining
       -- on a NULL pin matched no rows, so a visit documented entirely by
       -- carry-forward, which once left the pin NULL, was reported — on
       -- screen and in the auditor's PDF — as containing no documentation.
       -- Same resolution as the note editor and the sign guard.
       WHERE t.template_id = COALESCE(
               (SELECT note_template_id FROM visit WHERE id = ${visitId}::uuid AND org_id = ${orgId}::uuid),
               (SELECT nt.id FROM note_template nt
                 WHERE nt.org_id = ${orgId}::uuid AND nt.is_active LIMIT 1))
         AND t.org_id = ${orgId}::uuid
       ORDER BY t.sort_order
    `;

    const vitals = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT weight_kg, height_cm, bp_systolic, bp_diastolic, heart_rate, resp_rate,
             temperature_c, spo2_percent, pps_percent, pain_score, recorded_at
        FROM visit_vitals WHERE visit_id = ${visitId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `;

    // Corrections recorded after signing (audit R15), in the order signed.
    const addenda = await tx.$queryRaw<PacketData["addenda"]>`
      SELECT a.body, a.author_credential, a.signed_at, u.full_name AS author_name
        FROM visit_addendum a
        LEFT JOIN app_user u ON u.id = a.author_user_id
       WHERE a.visit_id = ${visitId}::uuid AND a.org_id = ${orgId}::uuid
       ORDER BY a.signed_at, a.id
    `;

    // The care-team header (audit R30): the patient's outside providers, and
    // the family members who hold the POA or primary-caregiver role.
    const patientId = p[0]?.id ?? null;
    const headerProviders = patientId
      ? await tx.$queryRaw<HeaderProvider[]>`
          SELECT l.role, l.role_label, ep.full_name, ep.npi, ep.phone
            FROM patient_external_provider l
            JOIN external_provider ep ON ep.id = l.external_provider_id AND ep.org_id = l.org_id
           WHERE l.patient_id = ${patientId}::uuid AND l.org_id = ${orgId}::uuid
        `
      : [];
    const headerContacts = patientId
      ? await tx.$queryRaw<HeaderContact[]>`
          SELECT full_name, phone, is_healthcare_poa, is_primary_caregiver
            FROM patient_contact
           WHERE patient_id = ${patientId}::uuid AND org_id = ${orgId}::uuid
             AND (is_healthcare_poa OR is_primary_caregiver)
        `
      : [];

    const sb = await tx.$queryRaw<NonNullable<PacketData["superbill"]>[]>`
      SELECT s.id, s.status, s.cpt_codes, s.cpt_units, s.icd10_codes, s.modifiers,
             s.billed_amount_cents, s.provider_npi, s.provider_name, s.billing_npi,
             s.place_of_service_code,
             s.member_id_snapshot, py.name AS payer_name
        FROM superbill s
        LEFT JOIN payer py ON py.id = s.payer_id
       WHERE s.visit_id = ${visitId}::uuid AND s.org_id = ${orgId}::uuid
       ORDER BY s.created_at DESC LIMIT 1
    `;

    const documentation = await loadDocumentationGaps(tx, { visitId });

    const orgRow = await tx.$queryRaw<{ name: string; timezone: string }[]>`
      SELECT name, timezone FROM org WHERE id = ${orgId}::uuid LIMIT 1
    `;
    if (!orgRow[0]) throw new NotFoundError("Organization not found.");
    const brand = await tx.$queryRaw<{ display_name: string | null; primary_color: string | null }[]>`
      SELECT display_name, primary_color FROM org_branding WHERE org_id = ${orgId}::uuid LIMIT 1
    `;

    return {
      visit: v[0],
      patient: p[0],
      // A vitals section's content lives in visit_vitals, never in its own
      // visit_note_section row — so the join above always reported it empty,
      // and the reconciliation told an auditor "Not documented: Vitals" in the
      // same PDF that prints the vitals table. Judge it by the readings: the
      // rule getVisitNote already applies.
      sections: sections.map((s) =>
        s.kind === "vitals"
          ? {
              ...s,
              is_empty: !(
                vitals[0] &&
                [
                  "weight_kg", "height_cm", "bp_systolic", "bp_diastolic", "heart_rate",
                  "resp_rate", "temperature_c", "spo2_percent", "pps_percent", "pain_score",
                ].some((col) => vitals[0]![col] !== null && vitals[0]![col] !== undefined)
              ),
            }
          : s,
      ),
      vitals: vitals[0] ?? null,
      addenda,
      careTeam: careTeamHeaderRows({
        palliativeProvider: p[0]?.palliative_provider_name ?? null,
        providers: headerProviders,
        contacts: headerContacts,
      }),
      documentation,
      superbill: sb[0] ?? null,
      orgName: brand[0]?.display_name ?? orgRow[0].name,
      timeZone: orgRow[0].timezone,
      primary: brand[0]?.primary_color ?? "#0d9488",
    };
  });
}

/**
 * The comparison itself. States facts and disagreements; never re-codes the
 * visit and never asserts the coding is correct — that is the auditor's call
 * and claiming otherwise in a document handed to a payer would be worse than
 * saying nothing.
 */
export function reconcile(d: PacketData): PacketFinding[] {
  const out: PacketFinding[] = [];
  const sb = d.superbill;
  const norm = (a: string[] | null | undefined) => [...new Set(a ?? [])].sort();

  if (!sb && d.visit.coding_basis === "non_billable") {
    // A "Not billed" visit type (audit R18): no bill is the correct state, and
    // offering to create one would only lead to a refusal.
    out.push({
      severity: "match",
      label: "Not billed",
      detail: "This visit type is not billed, so there is no claim to compare the note against.",
    });
  } else if (!sb) {
    // Whether a missing bill is a problem depends on whether the visit is
    // signed. Before signing it is simply not due yet — a draft is raised
    // automatically at sign-off. This reconciliation now also runs on unsigned
    // visits, and the old single wording told a clinician "this visit has been
    // signed" about a visit that had not been.
    const signed = ["documented", "pending_billing", "billed"].includes(d.visit.status);
    out.push(
      signed
        ? {
            severity: "attention",
            label: "No superbill",
            detail:
              "This visit has been signed but no superbill has been generated, so there is nothing to compare the note against.",
            action: "create_superbill",
          }
        : {
            severity: "attention",
            label: "No bill yet",
            detail:
              "A draft bill is created automatically when the visit is signed. Until then there is nothing to compare the note against.",
          },
    );
  } else {
    const onVisit = norm(d.visit.cpt_codes_assigned);
    const onBill = norm(sb.cpt_codes);
    // The same codes AND the same units on each (0106). A set comparison
    // alone read a bill with G0318 × 2 against a note supporting × 3 as
    // agreement; the units are what the add-on's time is billed as.
    const same = sameAssignment(onVisit, d.visit.cpt_units, onBill, sb.cpt_units);
    const visitCodes = formatCodes(onVisit, d.visit.cpt_units);
    const billCodes = formatCodes(onBill, sb.cpt_units);
    if (same) {
      out.push({
        severity: "match",
        label: "Procedure codes agree",
        detail: `The note and the bill carry the same CPT/HCPCS codes: ${billCodes || "none"}.`,
      });
    } else {
      out.push({
        severity: "mismatch",
        label: "Procedure codes differ",
        detail:
          `The bill carries ${billCodes || "none"} but the signed visit records ${visitCodes || "none"}. ` +
          "The bill was edited after the note was attested, or the note was coded and the bill was not rebuilt.",
      });
    }

    const dxVisit = norm(d.visit.icd10_codes);
    const dxBill = norm(sb.icd10_codes);
    if (dxBill.length === 0) {
      out.push({
        severity: "mismatch",
        label: "No diagnosis on the bill",
        detail: "A claim with no ICD-10 code will be rejected before it is adjudicated.",
      });
    } else if (dxVisit.length > 0 && dxVisit.join() !== dxBill.join()) {
      out.push({
        severity: "attention",
        label: "Diagnosis codes differ",
        detail: `The bill carries ${dxBill.join(", ")}; the visit records ${dxVisit.join(", ")}.`,
      });
    }

    if (!sb.provider_npi || sb.provider_npi.trim() === "") {
      out.push({
        severity: "mismatch",
        label: "No rendering-provider NPI",
        detail:
          "The bill names a rendering provider with no NPI. The one field identifying who performed the service is blank.",
      });
    } else if (sb.billing_npi && sb.provider_npi.trim() === sb.billing_npi.trim()) {
      // Audit R40: the organization's number standing in for the clinician's.
      out.push({
        severity: "attention",
        label: "Rendering NPI is the organization's",
        detail:
          "The bill names the organization's NPI as rendering provider. That box identifies the individual who performed the service — record the clinician's own NPI on the Team page.",
      });
    }

    // Where the visit took place against where the claim says it did (R23).
    const visitPos = d.visit.place_of_service_code;
    const billPos = sb.place_of_service_code;
    if (!visitPos) {
      out.push({
        severity: "attention",
        label: "Place of service not recorded on the visit",
        detail: `The bill says ${posLabel(billPos)}, but the visit never recorded where it took place, so that value was defaulted rather than documented.`,
      });
    } else if (billPos !== visitPos) {
      out.push({
        severity: "mismatch",
        label: "Place of service differs",
        detail: `The bill says ${posLabel(billPos)}; the visit records ${posLabel(visitPos)}.`,
      });
    } else {
      out.push({
        severity: "match",
        label: "Place of service agrees",
        detail: `${posLabel(visitPos)} on both the visit and the bill.`,
      });
    }
  }

  const filled = d.sections.filter((s) => !s.is_empty);
  const missing = d.sections.filter((s) => s.is_empty).map((s) => s.label);
  // Same status question as the missing bill: this runs before signing now,
  // and an empty draft is unfinished — not a defective attested note.
  const noteSigned = ["documented", "pending_billing", "billed"].includes(d.visit.status);
  out.push({
    severity: filled.length > 0 ? "match" : noteSigned ? "mismatch" : "attention",
    label: "Note content",
    detail:
      filled.length > 0
        ? `${filled.length} of ${d.sections.length} sections documented.` +
          (missing.length ? ` Not documented: ${missing.join(", ")}.` : "")
        : noteSigned
          ? "The signed note contains no documentation at all."
          : "Nothing has been written on this note yet.",
  });

  // The payer's own documentation standard, element by element (audit R19):
  // on screen while the note can still be fixed, and in the auditor's copy.
  if (d.documentation) {
    out.push(
      ...documentationFindings(d.documentation.results, d.documentation.payerName, {
        signed: noteSigned,
      }),
    );
  }

  const carried = d.sections.filter((s) => s.carried_unchanged).map((s) => s.label);
  if (carried.length > 0) {
    out.push({
      severity: "attention",
      label: "Carried forward unchanged",
      detail:
        `${carried.join(", ")} ${carried.length === 1 ? "was" : "were"} brought forward from an earlier visit and not edited. ` +
        "Text repeated verbatim across visits is what a payer looks for when it suspects a cloned note.",
    });
  }

  if (d.visit.total_minutes != null) {
    const acp = d.visit.acp_minutes ?? 0;
    out.push({
      severity: "match",
      label: "Time documented",
      detail:
        `${d.visit.total_minutes} minutes total` +
        (acp > 0 ? `, of which ${acp} minutes advance care planning.` : ".") +
        " Recorded from the start and stop times captured during the visit.",
    });
  } else {
    out.push({
      severity: "attention",
      label: "No time recorded",
      detail:
        "No start/stop time was captured, so a time-based code on this visit cannot be defended from the record.",
    });
  }

  if (d.visit.is_telehealth) {
    // The BILL's modifiers only — never the visit's.
    //
    // This used to read `sb?.modifiers ?? d.visit.modifiers`, so a visit with
    // no superbill at all was checked against its own record and reported
    // "billed with modifier 95" when nothing had been billed. The whole point
    // of this document is comparing the note against the bill [10:12]; falling
    // back to the note compares it against itself and always agrees.
    if (!sb) {
      out.push({
        severity: "attention",
        label: "Telehealth modifier",
        detail:
          "This is recorded as a telehealth visit, but there is no superbill yet, so no modifier has been billed to check.",
      });
    } else {
      const mods = norm(sb.modifiers);
      const billed = mods.filter((m) => m === "95" || m === "93");
      out.push({
        severity: billed.length > 0 ? "match" : "mismatch",
        label: "Telehealth modifier",
        detail:
          billed.length > 0
            ? `Telehealth visit billed with modifier ${billed.join(", ")}.`
            : "This is recorded as a telehealth visit but the bill carries neither modifier 95 (audio + video) nor 93 (audio only).",
      });
    }
  }

  // Corrections after signing (audit R15): the note an auditor reads is the
  // note plus these, and they are printed after it.
  const addenda = d.addenda ?? [];
  if (addenda.length > 0) {
    const latest = addenda[addenda.length - 1]!;
    out.push({
      severity: "attention",
      label: "Addenda",
      detail:
        `${addenda.length} addend${addenda.length === 1 ? "um" : "a"} recorded after signing, ` +
        `the latest on ${orgLocalDate(latest.signed_at, d.timeZone)}. They are printed after the signed note.`,
    });
  }

  return out;
}

const SEV_COLOUR: Record<PacketFinding["severity"], string> = {
  match: "#0f766e",
  attention: "#b45309",
  mismatch: "#b91c1c",
};
const SEV_LABEL: Record<PacketFinding["severity"], string> = {
  match: "Consistent",
  attention: "Review",
  mismatch: "Discrepancy",
};


/**
 * The note on its own, as a finished document.
 *
 * Mark, watching the single free-text box [06:43]: "it'll give you some
 * structure to understand how it needs to look on the finished product." The
 * renderer for that already existed but only ran inside the PDF, so the only
 * way to see the finished product was to export it — which clinicians cannot
 * do, and which refuses unsigned visits, i.e. exactly when a clinician would
 * want to look.
 *
 * Same renderSectionHtml the packet uses, so the preview and the audit
 * document cannot drift apart.
 */
export async function getNotePreviewHtml(args: {
  orgId: string;
  visitId: string;
}): Promise<{ html: string; signed: boolean }> {
  const d = await load(args.orgId, args.visitId);
  const dob = d.patient.date_of_birth.toISOString().slice(0, 10);
  // The visit's start is an instant: its day where the practice is (0107).
  const dos = d.visit.dos ? orgLocalDate(d.visit.dos, d.timeZone) : "—";
  const vitals = renderVitalsRows(d.vitals);

  // The identification block from page 1 of The Perfect Note: who, when,
  // what kind of encounter.
  const header =
    `<header class="np-hd">` +
    `<h1>${escapeHtml(d.patient.last_name)}, ${escapeHtml(d.patient.first_name)}</h1>` +
    `<dl>` +
    `<div><dt>DOB</dt><dd>${escapeHtml(dob)}</dd></div>` +
    // The member identifier the payer's rules name (audit R32).
    `<div><dt>Member ID</dt><dd>${escapeHtml(d.patient.primary_member_id || d.superbill?.member_id_snapshot || "—")}</dd></div>` +
    `<div><dt>Date of visit</dt><dd>${escapeHtml(dos)}</dd></div>` +
    `<div><dt>Visit</dt><dd>${escapeHtml(d.visit.visit_type_label ?? "—")}</dd></div>` +
    `<div><dt>Place of service</dt><dd>${escapeHtml(posLabel(d.visit.place_of_service_code))}</dd></div>` +
    `<div><dt>Clinician</dt><dd>${escapeHtml(d.visit.clinician_name ?? "—")}</dd></div>` +
    `</dl>` +
    // The care-team block of the same header (audit R30), on its own line.
    ((d.careTeam ?? []).length > 0
      ? `<dl class="np-ct">` +
        (d.careTeam ?? [])
          .map((r) => `<div><dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd></div>`)
          .join("") +
        `</dl>`
      : "") +
    `</header>`;

  const body = d.sections
    .map((s) => {
      const inner =
        s.kind === "vitals"
          ? vitals
            ? `<table class="np-vitals">${vitals}</table>`
            : ""
          : renderSectionHtml(s.kind, s.content);
      if (!inner) return "";
      const carried = s.carried_unchanged
        ? ` <span class="np-carried">carried forward · unedited</span>`
        : "";
      return `<section><h2>${escapeHtml(s.label)}${carried}</h2>${inner}</section>`;
    })
    .join("");

  const empty = body === "" ? `<p class="np-empty">Nothing has been written yet.</p>` : "";

  // Who attested it, under which credential (audit R32), after the addenda.
  const attestation = renderAttestationLine({
    signerName: d.visit.signer_name,
    signerCredential: d.visit.signer_credential,
    signedAt: d.visit.signed_at,
    signedByUserId: d.visit.signed_by_user_id,
    clinicianUserId: d.visit.clinician_user_id,
    timeZone: d.timeZone,
  });

  return {
    html: header + body + empty + renderAddendaHtml(d.addenda ?? [], d.timeZone) + attestation,
    signed: ["documented", "pending_billing", "billed"].includes(d.visit.status),
  };
}

function renderHtml(d: PacketData, findings: PacketFinding[]): string {
  const dob = d.patient.date_of_birth.toISOString().slice(0, 10);
  // As on the preview: the visit's day where the practice is (0107).
  const dos = d.visit.dos ? orgLocalDate(d.visit.dos, d.timeZone) : "—";
  const sb = d.superbill;
  // The patient record's member ID; the bill's snapshot as a fallback (R32).
  const memberId = d.patient.primary_member_id || sb?.member_id_snapshot || "—";
  // The care-team header (audit R30). It is read live, so the caption says
  // it shows what is on file at export — never that it is what stood when
  // the note was signed.
  const careTeam = d.careTeam ?? [];
  const careTeamRows = careTeam
    .map((r) => `<tr><td class="k">${escapeHtml(r.label)}</td><td>${escapeHtml(r.value)}</td></tr>`)
    .join("");
  const careTeamCaption =
    careTeam.length > 0
      ? `<p class="sub">Outside providers and contacts as on file at export (${orgToday(d.timeZone)}).</p>`
      : "";

  const vitalsRows = renderVitalsRows(d.vitals);

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Audit packet ${escapeHtml(d.visit.id.slice(0, 8))}</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; margin: 0; font-size: 12px; line-height: 1.5; }
  .hd { display: flex; justify-content: space-between; border-bottom: 3px solid ${d.primary}; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { font-size: 18px; font-weight: 700; margin: 0; color: ${d.primary}; }
  .sub { font-size: 11px; color: #64748b; }
  .meta { font-size: 10px; text-align: right; color: #475569; line-height: 1.6; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #475569;
       margin: 18px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 12px; margin: 12px 0 3px; color: #0f172a; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 6px; vertical-align: top; font-size: 11px; }
  .k { color: #64748b; width: 32%; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .sec { margin-bottom: 10px; page-break-inside: avoid; }
  .sec p { margin: 3px 0; }
  .sec ul, .sec ol { margin: 3px 0 3px 18px; padding: 0; }
  .empty { color: #94a3b8; font-style: italic; }
  .flag { display: inline-block; font-size: 9px; text-transform: uppercase; letter-spacing: .05em;
          color: #b45309; border: 1px solid #b45309; border-radius: 2px; padding: 0 4px; margin-left: 6px; }
  .find { border-left: 3px solid #cbd5e1; padding: 4px 0 4px 8px; margin-bottom: 7px; page-break-inside: avoid; }
  .find .t { font-weight: 600; font-size: 11px; }
  .find .s { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; margin-left: 6px; }
  .find .d { font-size: 10.5px; color: #334155; }
  .attest { margin-top: 16px; border: 1px solid #cbd5e1; padding: 8px 10px; page-break-inside: avoid; }
  .footer { margin-top: 20px; font-size: 9px; color: #64748b; }
</style></head><body>
  <div class="hd">
    <div>
      <h1>${escapeHtml(d.orgName)}</h1>
      <div class="sub">Visit audit packet — signed note and superbill</div>
    </div>
    <div class="meta">
      <div>Visit <span class="mono">${escapeHtml(d.visit.id)}</span></div>
      <div>Date of service <strong>${dos}</strong></div>
      <div>Status <strong>${escapeHtml(d.visit.status)}</strong></div>
    </div>
  </div>

  <h2>Patient</h2>
  <table>
    <tr><td class="k">Name</td><td><strong>${escapeHtml(d.patient.last_name)}, ${escapeHtml(d.patient.first_name)}</strong></td></tr>
    <tr><td class="k">Date of birth</td><td class="mono">${dob}</td></tr>
    <tr><td class="k">Member ID</td><td class="mono">${escapeHtml(memberId)}</td></tr>
    <tr><td class="k">Visit type</td><td>${escapeHtml(d.visit.visit_type_label ?? "—")}</td></tr>
    <tr><td class="k">Place of service</td><td>${escapeHtml(posLabel(d.visit.place_of_service_code))}</td></tr>
    ${d.visit.is_telehealth ? `<tr><td class="k">Modality</td><td>Telehealth (${escapeHtml(d.visit.telehealth_modality ?? "unspecified")})</td></tr>` : ""}
    ${careTeamRows}
  </table>
  ${careTeamCaption}

  <h2>Reconciliation — note against bill</h2>
  ${findings
    .map(
      (f) => `<div class="find" style="border-left-color:${SEV_COLOUR[f.severity]}">
      <div><span class="t">${escapeHtml(f.label)}</span><span class="s" style="color:${SEV_COLOUR[f.severity]}">${SEV_LABEL[f.severity]}</span></div>
      <div class="d">${escapeHtml(f.detail)}</div>
    </div>`,
    )
    .join("")}

  <h2>Signed note</h2>
  ${renderNoteBodyHtml(d.sections, vitalsRows)}

  ${renderAddendaHtml(d.addenda ?? [], d.timeZone)}

  <h2>Superbill</h2>
  ${
    sb
      ? `<table>
    <tr><td class="k">Superbill</td><td class="mono">${escapeHtml(sb.id)}</td></tr>
    <tr><td class="k">Status</td><td>${escapeHtml(sb.status)}</td></tr>
    <tr><td class="k">Payer</td><td>${escapeHtml(sb.payer_name ?? "—")}</td></tr>
    <tr><td class="k">Member ID</td><td class="mono">${escapeHtml(sb.member_id_snapshot ?? "—")}</td></tr>
    <tr><td class="k">Rendering provider</td><td>${escapeHtml(sb.provider_name ?? "—")} · NPI <span class="mono">${escapeHtml(sb.provider_npi || "not recorded")}</span></td></tr>
    <tr><td class="k">Billing provider</td><td>NPI <span class="mono">${escapeHtml(sb.billing_npi || "not recorded")}</span></td></tr>
    <tr><td class="k">Place of service</td><td>${escapeHtml(posLabel(sb.place_of_service_code))}</td></tr>
    <tr><td class="k">CPT / HCPCS</td><td class="mono">${escapeHtml(formatCodes(sb.cpt_codes ?? [], sb.cpt_units) || "—")}</td></tr>
    <tr><td class="k">ICD-10</td><td class="mono">${escapeHtml((sb.icd10_codes ?? []).join(", ") || "—")}</td></tr>
    <tr><td class="k">Modifiers</td><td class="mono">${escapeHtml((sb.modifiers ?? []).join(", ") || "—")}</td></tr>
    <tr><td class="k">Billed</td><td><strong>$${(Number(sb.billed_amount_cents) / 100).toFixed(2)}</strong></td></tr>
  </table>`
      : `<p class="empty">No superbill has been generated for this visit.</p>`
  }

  <div class="attest">
    <strong>Attestation</strong><br />
    ${renderAttestationLine({
      signerName: d.visit.signer_name,
      signerCredential: d.visit.signer_credential,
      signedAt: d.visit.signed_at,
      signedByUserId: d.visit.signed_by_user_id,
      clinicianUserId: d.visit.clinician_user_id,
      timeZone: d.timeZone,
    })}
    ${d.visit.signer_email ? `Signer email: ${escapeHtml(d.visit.signer_email)}.<br />` : ""}
    Clinician of record: ${escapeHtml(d.visit.clinician_name ?? "—")}.
  </div>

  <p class="footer">
    Generated by Pallio for ${escapeHtml(d.orgName)}. Contains PHI under HIPAA; this disclosure is
    recorded in <span class="mono">phi_export_log</span>. The reconciliation above reports what the
    record contains and where the note and the bill disagree. It is not a coding opinion.
  </p>
</body></html>`;
}
