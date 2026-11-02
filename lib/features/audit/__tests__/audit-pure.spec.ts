/**
 * One readable line per audit row (audit R24), from a WHITELIST.
 *
 * The page used to print an 8-character target id and nothing else, so the
 * note-to-claim pairing the log did record was invisible. The summary must
 * surface it without ever printing a payload key it was not told about.
 */
import { describe, expect, it } from "vitest";

import { redactAuditPayload, summarizeAuditPayload } from "../audit-pure";

const VISIT = "e0000000-0000-4000-8000-00000000000a";
const SB = "b2e303af-e2cb-4292-8d00-c35c07423a0d";
const OTHER = "e0000000-0000-4000-8000-00000000000c";

describe("summarizeAuditPayload", () => {
  it("superbill_create names the codes and amount, and links the visit from the payload", () => {
    const s = summarizeAuditPayload("superbill_create", "superbill", SB, {
      visitId: VISIT, cptCodes: ["99344"], billedAmountCents: 21000, patientId: "p", payerId: null, riskScored: true,
    });
    expect(s).toEqual({ text: "Claim · CPT 99344 · $210.00", visitId: VISIT });
  });

  it("superbill_status_change reads as a move, with the paid amount and any documentation override", () => {
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "submitted", to: "partially_paid", paidAmountCents: 15000, visitId: VISIT,
      }),
    ).toEqual({ text: "submitted → partially paid · paid $150.00", visitId: VISIT });
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "ready_to_submit", to: "submitted", documentationOverride: ["chief_complaint"],
      }).text,
    ).toBe("ready to submit → submitted · submitted over a documentation gap (chief complaint)");
  });

  it("denial decisions and outcomes carry the decision, never notes", () => {
    expect(summarizeAuditPayload("denial_decision", "denial", SB, { decision: "write_off", visitId: VISIT })).toEqual({
      text: "Decision: write off", visitId: VISIT,
    });
    expect(summarizeAuditPayload("denial_outcome", "denial", SB, { outcome: "paid", amountCents: 5000 }).text).toBe(
      "Outcome: paid · $50.00",
    );
  });

  it("visit rows link their own visit", () => {
    expect(
      summarizeAuditPayload("visit_sign", "visit", VISIT, {
        from: "in_progress", to: "pending_billing", credential: "MD", signerIsClinicianOfRecord: false,
      }),
    ).toEqual({ text: "in progress → pending billing · signed as MD · not the clinician of record", visitId: VISIT });
    expect(summarizeAuditPayload("visit_document", "visit", VISIT, { from: "scheduled", to: "in_progress" }).visitId).toBe(VISIT);
    expect(summarizeAuditPayload("visit_vitals_record", "visit", VISIT, { fields: ["weight_kg", "bp_systolic"] }).text).toBe(
      "Fields: weight kg, bp systolic",
    );
    expect(summarizeAuditPayload("visit_addendum", "visit", VISIT, { addendumId: SB, length: 1 }).text).toBe(
      "Addendum signed · 1 character",
    );
  });

  it("a visit type corrected before sign-off names the two bands and whether codes were cleared", () => {
    expect(
      summarizeAuditPayload("visit_type_change", "visit", VISIT, {
        fromBasis: "established_patient_home", toBasis: "new_patient_home", codesCleared: true,
      }),
    ).toEqual({ text: "Visit type: established patient home → new patient home · codes cleared", visitId: VISIT });
    // CONTROL: the same band on both sides keeps the codes and says nothing more.
    expect(
      summarizeAuditPayload("visit_type_change", "visit", VISIT, {
        fromBasis: "established_patient_home", toBasis: "established_patient_home", codesCleared: false,
      }).text,
    ).toBe("Visit type: established patient home → established patient home");
  });

  it("prints only closed-set bands from a visit type change, never the org's own words", () => {
    // A band outside VISIT_TYPES is free text — an org slug, a label, a name —
    // and never reaches the screen through here, whatever the row carries.
    const s = summarizeAuditPayload("visit_type_change", "visit", VISIT, {
      fromBasis: "Dr Smith notes", toBasis: "new_patient_home", codesCleared: true,
      fromSlug: "smith_special", patientName: "Singleton",
    });
    expect(s).toEqual({ text: "codes cleared", visitId: VISIT });
    expect(s.text).not.toContain("Smith");
    expect(s.text).not.toContain("Singleton");
    expect(
      summarizeAuditPayload("visit_type_change", "visit", VISIT, {
        fromBasis: "established_patient_home", toBasis: "bereavement_follow_up", codesCleared: "yes",
      }).text,
    ).toBe("");
  });

  it("a visit moved on the schedule says so and names the columns written", () => {
    expect(
      summarizeAuditPayload("visit_reschedule", "visit", VISIT, { fields: ["scheduled_end", "scheduled_start"] }),
    ).toEqual({ text: "Rescheduled · Fields: scheduled end, scheduled start", visitId: VISIT });
  });

  it("prints only the two schedule columns from a reschedule, never a time or a name", () => {
    // A scheduled time is a date of service. Whatever a row carries, only the
    // whitelisted column names reach the screen.
    const s = summarizeAuditPayload("visit_reschedule", "visit", VISIT, {
      fields: ["scheduled_start", "2026-09-30T13:30:00Z", "Mary Singleton"],
      from: "2026-09-29T13:30:00Z", to: "2026-09-30T13:30:00Z",
    });
    expect(s).toEqual({ text: "Rescheduled · Fields: scheduled start", visitId: VISIT });
    expect(s.text).not.toContain("2026");
    expect(s.text).not.toContain("Singleton");
  });

  it("CONTROL — a reschedule row links its own visit, and only a real visit id", () => {
    expect(summarizeAuditPayload("visit_reschedule", "visit", VISIT, {}).visitId).toBe(VISIT);
    expect(summarizeAuditPayload("visit_reschedule", "visit", "not-a-uuid", {}).visitId).toBeNull();
  });

  it("carry-forward names how many sections came from which visit", () => {
    expect(
      summarizeAuditPayload("visit_note_carry_forward", "visit", VISIT, {
        fromVisitId: OTHER, copied: ["hpi", "social_history"], skipped: [],
      }),
    ).toEqual({ text: "Copied 2 sections · from visit e0000000", visitId: VISIT });
  });

  it("covers the org-level actions", () => {
    expect(summarizeAuditPayload("note_template_edit", "note_template", SB, { version: 3 }).text).toBe("Version 3");
    expect(
      summarizeAuditPayload("clinician_profile_update", "user", SB, { fields: ["npi"], openBillsUpdated: 2 }).text,
    ).toBe("Fields: npi · 2 open bills updated");
    expect(
      summarizeAuditPayload("team_permissions_update", "user", SB, { added: ["audit.view"], removed: [] }).text,
    ).toBe("Added audit.view");
    expect(summarizeAuditPayload("patient_update", "patient", SB, { sections: ["insurance"] }).text).toBe(
      "Sections: insurance",
    );
    expect(summarizeAuditPayload("patient_export", "patient", SB, { format: "pdf", bytes: 20480 }).text).toBe(
      "PDF · 20 KB",
    );
  });

  // Every settings row read "—" on the audit page: the payload said what
  // changed and nothing printed it.
  it("settings changes say what changed, how, and which fields", () => {
    expect(
      summarizeAuditPayload("settings_update", "practice", null, { change: "edit", fields: ["dailyVisitCapacity", "timezone"] }).text,
    ).toBe("Practice settings edited · Fields: visits per clinician per day, time zone");
    expect(summarizeAuditPayload("settings_update", "visit_type", SB, { change: "deactivate", fields: ["active"] }).text).toBe(
      "Visit type deactivated",
    );
    expect(
      summarizeAuditPayload("settings_update", "visit_service", SB, { change: "edit", fields: ["cptHint", "name"] }).text,
    ).toBe("Visit service edited · Fields: CPT hint, name");
    expect(
      summarizeAuditPayload("settings_update", "branding", null, { change: "edit", fields: ["customDomain", "primaryColor"] }).text,
    ).toBe("Branding edited · Fields: custom domain, primary color");
    expect(
      summarizeAuditPayload("settings_update", "visit_type", SB, {
        change: "create", label: "Bereavement call", codingBasis: "non_billable", isTelehealth: false,
      }).text,
    ).toBe("Visit type added · bills like non billable");
  });

  it("prints no org-written name, label or domain from a settings row, whatever it carries", () => {
    const created = summarizeAuditPayload("settings_update", "visit_service", SB, {
      change: "create", name: "Grief call with Mrs Jones", category: "psychosocial",
    }).text;
    expect(created).toBe("Visit service added");
    const odd = summarizeAuditPayload("settings_update", "visit_type", SB, {
      change: "edit", fields: ["label", "Mrs Jones"], codingBasis: "Mrs Jones",
    }).text;
    expect(odd).toBe("Visit type edited · Fields: name");
    expect(summarizeAuditPayload("settings_update", "something_new", null, { change: "edit" }).text).toBe("");
  });

  it("payer roster changes name the payer and its states: reference data, not PHI (audit R17)", () => {
    expect(
      summarizeAuditPayload("payer_roster_change", "payer", SB, {
        op: "create", name: "Pallio Test MA Plan", payerType: "medicare_advantage_org",
        fields: ["name", "payer_type", "states_served"], statesServed: ["UT"],
      }),
    ).toEqual({ text: "Payer added · Pallio Test MA Plan · States: UT", visitId: null });
    expect(
      summarizeAuditPayload("payer_roster_change", "payer", SB, {
        op: "update", name: "Aetna", fields: ["active"], active: false,
      }).text,
    ).toBe("Payer edited · Aetna · withdrawn from pickers");
    expect(
      summarizeAuditPayload("payer_roster_change", "payer", SB, {
        op: "update", name: "Aetna", fields: ["notes", "states_served"], statesServed: ["OH", "NC"], notes: "call Jane",
      }).text,
    ).toBe("Payer edited · Aetna · States: OH, NC · Fields: notes, states served");
  });

  it("contact and provider changes name columns and roles, never the person (audit R30)", () => {
    expect(
      summarizeAuditPayload("patient_contact_change", "patient", SB, {
        contactId: SB, op: "create", fields: ["full_name", "is_healthcare_poa", "phone"],
      }),
    ).toEqual({ text: "Contact added · Fields: full name, is healthcare poa, phone", visitId: null });
    expect(summarizeAuditPayload("patient_contact_change", "patient", SB, { contactId: SB, op: "delete" }).text).toBe(
      "Contact removed",
    );
    expect(
      summarizeAuditPayload("patient_provider_change", "patient", SB, {
        linkId: SB, providerId: SB, op: "link", role: "primary_care", providerCreated: true,
      }).text,
    ).toBe("Outside provider linked · primary care provider · new to the roster");
    expect(summarizeAuditPayload("patient_provider_change", "patient", SB, { op: "unlink", role: "specialist" }).text).toBe(
      "Outside provider removed · specialist",
    );
    expect(
      summarizeAuditPayload("external_provider_change", "external_provider", SB, { op: "update", fields: ["fax", "phone"] }).text,
    ).toBe("Roster provider edited · Fields: fax, phone");
  });

  it("prints no name or number from a contact or provider payload, whatever it carries", () => {
    const s = summarizeAuditPayload("patient_contact_change", "patient", SB, {
      op: "update", fields: ["phone", "Mary Singleton"], fullName: "Mary Singleton", phone: "614-555-0142",
    });
    expect(s.text).toBe("Contact edited · Fields: phone");
    expect(
      summarizeAuditPayload("patient_provider_change", "patient", SB, { op: "link", role: "Dr Alan Brooks" }).text,
    ).toBe("Outside provider linked");
    expect(
      summarizeAuditPayload("external_provider_change", "external_provider", SB, {
        op: "create", fields: ["npi", "614-555-0100"], fullName: "Dr Alan Brooks",
      }).text,
    ).toBe("Roster provider added · Fields: npi");
  });

  it("an uploaded 835 reads as counts, and a posting from one says so (audit R10)", () => {
    expect(
      summarizeAuditPayload("remittance_post", "remittance", SB, {
        claims: 2, paid: 1, partiallyPaid: 0, denied: 0, unmatched: 1, needsReview: 0,
        errors: 0, alreadyPosted: 0, totalPaidCents: 9850, alreadyUploaded: false,
      }),
    ).toEqual({ text: "835 · 2 claims · 1 paid · 1 unmatched · $98.50 posted", visitId: null });
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "submitted", to: "paid", paidAmountCents: 9850, visitId: VISIT,
        source: "remittance", remittanceFileId: SB,
      }).text,
    ).toBe("submitted → paid · paid $98.50 · per payer remittance");
    expect(
      summarizeAuditPayload("denial_outcome", "denial", SB, { outcome: "secondary_denial", source: "remittance" }).text,
    ).toBe("Outcome: secondary denial · per payer remittance");
  });

  it("a remittance's step through submitted names the documentation gap it recorded, as element keys only (audit R10, R19)", () => {
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "ready_to_submit", to: "submitted", visitId: VISIT,
        documentationGap: ["chief_complaint", "physical_exam"], source: "remittance", remittanceFileId: SB,
      }),
    ).toEqual({
      text: "ready to submit → submitted · documentation gap (chief complaint, physical exam) · per payer remittance",
      visitId: VISIT,
    });
    // Anything that is not an element key never prints.
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "ready_to_submit", to: "submitted", documentationGap: ["Stephen Singleton", "chief_complaint"],
      }).text,
    ).toBe("ready to submit → submitted · documentation gap (chief complaint)");
    // CONTROL: without the key the line reads as it always did.
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "ready_to_submit", to: "submitted", source: "remittance",
      }).text,
    ).toBe("ready to submit → submitted · per payer remittance");
  });

  it("a denial recovery confirmed as above what was denied says so too (audit R24)", () => {
    // recordOutcome writes overpayment: { deniedAmountCents } once the biller
    // confirms a recovery larger than the line the payer denied — the same
    // hole as the row below, on the same screen: an over-recovery printed as
    // an ordinary one.
    expect(
      summarizeAuditPayload("denial_outcome", "denial", SB, {
        outcome: "paid", amountCents: 12000, visitId: VISIT,
        overpayment: { deniedAmountCents: 4000 },
      }),
    ).toEqual({
      text: "Outcome: paid · $120.00 · more than the $40.00 denied, confirmed as an overpayment",
      visitId: VISIT,
    });
    // CONTROL: the same recovery without the key reads exactly as it did before.
    expect(
      summarizeAuditPayload("denial_outcome", "denial", SB, {
        outcome: "paid", amountCents: 12000, visitId: VISIT,
      }).text,
    ).toBe("Outcome: paid · $120.00");
    // One number is read, so a key this object one day grows never prints.
    expect(
      summarizeAuditPayload("denial_outcome", "denial", SB, {
        outcome: "paid", amountCents: 12000,
        overpayment: { deniedAmountCents: 4000, patientName: "Singleton" },
      }).text,
    ).toBe("Outcome: paid · $120.00 · more than the $40.00 denied, confirmed as an overpayment");
    // A malformed amount asserts nothing rather than claiming an overpayment.
    expect(
      summarizeAuditPayload("denial_outcome", "denial", SB, {
        outcome: "paid", amountCents: 12000, overpayment: { deniedAmountCents: "lots" },
      }).text,
    ).toBe("Outcome: paid · $120.00");
  });

  it("a payment confirmed as above the bill says so on the row (audit R24)", () => {
    // Exactly what markStatusTx writes once a biller confirms an overpayment:
    // overpayment: { billedAmountCents }. /audit printed that row as an
    // ordinary "paid $120.00", and /audit is the screen an auditor reads to
    // find a payment larger than the claim.
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "submitted", to: "paid", paidAmountCents: 12000, visitId: VISIT,
        overpayment: { billedAmountCents: 10179 },
      }),
    ).toEqual({
      text: "submitted → paid · paid $120.00 · more than the $101.79 billed, confirmed as an overpayment",
      visitId: VISIT,
    });
    // CONTROL: the same payment without the key reads exactly as it did before.
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "submitted", to: "paid", paidAmountCents: 12000, visitId: VISIT,
      }).text,
    ).toBe("submitted → paid · paid $120.00");
    // The object is read for one number, so a key it one day grows never prints.
    expect(
      summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "submitted", to: "paid", paidAmountCents: 12000,
        overpayment: { billedAmountCents: 10179, patientName: "Singleton" },
      }).text,
    ).toBe("submitted → paid · paid $120.00 · more than the $101.79 billed, confirmed as an overpayment");
  });

  it("a malformed overpayment field neither throws nor claims an overpayment", () => {
    // An audit row cannot be edited for six years, so a row whose overpayment
    // field is not the shape markStatusTx writes must say nothing rather than
    // put "confirmed as an overpayment" — a finding — in front of an auditor
    // on a payload that does not establish one.
    const malformed: unknown[] = [
      true, 10179, "10179", null, [], {},
      { billedAmountCents: "10179" }, { billedAmountCents: Number.NaN },
      { billed_amount_cents: 10179 },
    ];
    for (const overpayment of malformed) {
      const s = summarizeAuditPayload("superbill_status_change", "superbill", SB, {
        from: "submitted", to: "paid", paidAmountCents: 12000, visitId: VISIT, overpayment,
      });
      expect(s.text).toBe("submitted → paid · paid $120.00");
      expect(s.text).not.toContain("overpayment");
    }
  });

  it("prints nothing from an 835 upload beyond its counts, whatever the payload carries", () => {
    const s = summarizeAuditPayload("remittance_post", "remittance", SB, {
      claims: 1, denied: 1, claimId: "B2E303AFE2CB", memberId: "TESTMEMBER1", patientName: "SINGLETON",
    });
    expect(s).toEqual({ text: "835 · 1 claim · 1 denied", visitId: null });
  });

  it("never prints a payload key outside the whitelist", () => {
    const s = summarizeAuditPayload("superbill_create", "superbill", SB, {
      visitId: VISIT, cptCodes: ["99344"], firstName: "Stephen", memberId: "M-777",
    });
    expect(s.text).not.toContain("Stephen");
    expect(s.text).not.toContain("M-777");
    const other = summarizeAuditPayload("login", null, null, { email: "a@b.test", firstName: "Stephen" });
    expect(other).toEqual({ text: "", visitId: null });
  });

  it("ignores a visitId that is not a uuid", () => {
    expect(summarizeAuditPayload("superbill_create", "superbill", SB, { visitId: "<script>" }).visitId).toBeNull();
  });

  it("says what kind of document was added, opened or removed, and never its name (0112)", () => {
    expect(
      summarizeAuditPayload("document_upload", "patient_document", SB, {
        subject: "referral", kind: "face_sheet", contentType: "application/pdf", sizeBytes: 348_160,
        fileName: "Smith_John_facesheet.pdf",
      }).text,
    ).toBe("Document added · face sheet · PDF, 340 KB · to a referral");
    expect(summarizeAuditPayload("document_view", "patient_document", SB, { fileName: "x" }).text).toBe("Document opened");
    expect(
      summarizeAuditPayload("document_remove", "patient_document", SB, { kind: "other", reason: "Wrong patient Smith" }).text,
    ).toBe("Document removed as filed in error · other");
    // CONTROL: a kind or type outside the closed sets prints nothing of itself.
    const odd = summarizeAuditPayload("document_upload", "patient_document", SB, {
      kind: "<b>Smith</b>", contentType: "text/html", subject: "x",
    });
    expect(odd.text).toBe("Document added");
  });

  it("names the list and what was done to it, never the diagnosis, drug or substance (0114)", () => {
    const s = (payload: Record<string, unknown>) => summarizeAuditPayload("clinical_list_change", "patient", SB, payload).text;
    expect(s({ list: "medications", op: "stop", itemId: SB, name: "Morphine" })).toBe("Entry stopped on the medication list");
    expect(s({ list: "problems", op: "edit", fields: ["onsetOn", "notes", "icd10"] })).toBe(
      "Entry edited on the problem list · Fields: onset, notes",
    );
    expect(s({ list: "no_known_allergies", op: "record" })).toBe("No known allergies recorded");
    // CONTROL: values outside the closed sets print nothing of themselves.
    expect(s({ list: "Penicillin", op: "<script>" })).toBe("Clinical list changed");
  });

  it("says what changed in the course of care, from closed sets only (0115)", () => {
    const s = (action: string, targetType: string, payload: Record<string, unknown>) =>
      summarizeAuditPayload(action, targetType, SB, payload);
    expect(s("acuity_change", "visit", { source: "visit", acuity: "high", patientId: SB })).toEqual({
      text: "Acuity given at the visit · high",
      visitId: SB,
    });
    expect(s("hospice_assessment", "patient", { assessmentId: SB, eligible: false }).text).toBe("Hospice eligibility assessed: not eligible");
    expect(s("patient_event_change", "patient", { op: "void", kind: "ed_visit", eventId: SB }).text).toBe("ED visit voided as recorded in error");
    expect(s("patient_event_change", "patient", { op: "add", kind: "hospice_referral", eventId: SB }).text).toBe("Hospice referral recorded");
    expect(s("patient_discharge", "patient", { op: "discharge", reasonCode: "01b", category: "hospice_partner", status: "discharged" }).text).toBe(
      "Discharged · code 01b",
    );
    expect(s("patient_discharge", "patient", { op: "discharge", reasonCode: "08", status: "deceased" }).text).toBe(
      "Discharged: died on service · code 08",
    );
    expect(s("patient_discharge", "patient", { op: "hospice_outcome", endReason: "revocation" }).text).toBe("Hospice stay ended · revoked hospice");
    expect(s("patient_discharge", "patient", { op: "hospice_details", fields: ["hospiceAdmittedOn"] }).text).toBe(
      "Hospice stay details recorded",
    );
    expect(s("patient_discharge", "patient", { op: "readmit" }).text).toBe("Readmitted to care");
    // CONTROL: values outside the closed sets print nothing of themselves.
    expect(s("acuity_change", "visit", { acuity: "Smith is worse" }).text).toBe("Acuity given at the visit");
    expect(s("patient_event_change", "patient", { op: "add", kind: "Fell at Mercy" }).text).toBe("Event changed");
    expect(s("patient_discharge", "patient", { op: "discharge", reasonCode: "Hospice of Smith" }).text).toBe("Discharged");
    expect(s("patient_discharge", "patient", { op: "hospice_outcome", endReason: "<b>x</b>" }).text).toBe("Hospice stay ended");
  });

  it("says what changed between visits, from closed sets only (0116)", () => {
    const s = (action: string, payload: Record<string, unknown>) => summarizeAuditPayload(action, "patient", SB, payload).text;
    expect(s("care_plan_update", { version: 6, duringVisit: true, parts: ["document", "escalation", "Morphine"] })).toBe(
      "Care plan saved (v6) · during a visit · Parts: document, escalation parameters",
    );
    expect(s("care_program_enrollment", { op: "enroll", program: "pcm", consentMethod: "verbal" })).toBe("Enrolled · PCM · verbal consent");
    expect(s("care_program_enrollment", { op: "end", program: "ccm" })).toBe("Enrolment ended · CCM");
    expect(s("phone_encounter", { op: "add", direction: "inbound" })).toBe("Phone call recorded: they called");
    expect(s("phone_encounter", { op: "void" })).toBe("Phone call voided as recorded in error");
    expect(s("escalation_alert", { op: "raise", measure: "pain", source: "vitals" })).toBe("Escalation alert raised · pain");
    expect(s("care_task", { op: "edit", discipline: "chaplaincy", fields: ["dueOn", "assigneeUserId"] })).toBe(
      "Task changed · for chaplaincy · Fields: due day, assignee",
    );
    // CONTROL: values outside the closed sets print nothing of themselves.
    expect(s("escalation_alert", { op: "raise", measure: "Pain 9 at night" })).toBe("Escalation alert raised");
    expect(s("care_task", { op: "<i>", discipline: "Call Ruth" })).toBe("Task changed");
    expect(s("care_program_enrollment", { op: "enroll", program: "Smith", consentMethod: "by email" })).toBe("Enrolled");
  });

  it("says what PCM/CCM time and charges did, from closed sets only, and opens the charge's visit (0117)", () => {
    const sum = (action: string, payload: Record<string, unknown>) => summarizeAuditPayload(action, "patient", SB, payload);
    expect(sum("care_management_time", { op: "log", program: "pcm", kind: "clinical_staff", minutes: 15, activity: "care_plan" }).text).toBe(
      "PCM time logged · 15 minutes · clinical staff · care plan work",
    );
    expect(sum("care_management_time", { op: "log", program: "ccm", kind: "qhp", minutes: 1, activity: "phone", fromCall: true }).text).toBe(
      "CCM time logged · 1 minute · practitioner · from a call",
    );
    expect(sum("care_management_time", { op: "void", program: "ccm", fromCall: true }).text).toBe(
      "CCM time voided as recorded in error · with its call",
    );
    const VISIT = "e0000000-0000-4000-8000-0000000000cc";
    const raised = sum("care_management_charge", {
      op: "raise", program: "ccm", basis: "staff", cptCodes: ["99490", "99439"], addOnUnits: 2, visitId: VISIT,
    });
    expect(raised).toEqual({ text: "CCM month charged · CPT 99490, 99439 · 2 add-on units · on clinical staff time", visitId: VISIT });
    // CONTROL: values outside the closed sets print nothing of themselves.
    expect(sum("care_management_time", { op: "log", program: "Ruth's", kind: "nurse Ann", activity: "called Ruth" }).text).toBe(
      "PCM/CCM time logged",
    );
    expect(sum("care_management_charge", { cptCodes: ["C34.12", "<b>"], basis: "Ruth", visitId: "not-a-uuid" })).toEqual({
      text: "PCM/CCM month charged",
      visitId: null,
    });
  });

  it("says another payment on a claim apart from its total (D9)", () => {
    const sum = (payload: Record<string, unknown>) => summarizeAuditPayload("superbill_status_change", "superbill", SB, payload);
    expect(sum({ from: "partially_paid", to: "partially_paid", paidAmountCents: 7000, paymentCents: 2000 }).text).toBe(
      "partially paid → partially paid · another payment $20.00 · paid $70.00 in all",
    );
    expect(sum({ from: "partially_paid", to: "paid", paidAmountCents: 10000, paymentCents: 3000, lastPayment: true }).text).toBe(
      "partially paid → paid · last payment $30.00 · paid $100.00 in all",
    );
    // CONTROL: a first payment reads as it always did.
    expect(sum({ from: "submitted", to: "partially_paid", paidAmountCents: 5000 }).text).toBe("submitted → partially paid · paid $50.00");
  });

  it("says what was loaded from CMS's NCCI files, in counts and dates (0122)", () => {
    const sum = (action: string, payload: Record<string, unknown>) => summarizeAuditPayload(action, "ncci_load", SB, payload);
    expect(sum("ncci_load", { kind: "ptp", change: "loaded", rowsKept: 3 }).text).toBe("NCCI pairs loaded from CMS's files · 3 pairs");
    expect(sum("ncci_load", { kind: "mue", change: "loaded", rowsKept: 1, inForceFrom: "2026-10-01" }).text).toBe(
      "MUE values loaded from CMS's files · 1 code · in force from 2026-10-01",
    );
    expect(sum("ncci_load", { kind: "ptp", change: "removed", rowsKept: 3 }).text).toBe("NCCI pairs no longer used · 3 pairs");
    // CONTROL: a date that is not one prints nothing of itself.
    expect(sum("ncci_load", { kind: "mue", change: "loaded", inForceFrom: "Ruth" }).text).toBe("MUE values loaded from CMS's files");
  });
});

describe("redactAuditPayload", () => {
  it("drops free-text keys an older writer stored, whatever the action", () => {
    expect(
      redactAuditPayload({ code: "99350", reason: "Pt with metastatic NSCLC, prolonged", reasonLength: 36 }),
    ).toEqual({ code: "99350", reasonLength: 36 });
    expect(redactAuditPayload({ notes: "x", visitId: "v" })).toEqual({ visitId: "v" });
    expect(redactAuditPayload(null)).toEqual({});
  });
});
