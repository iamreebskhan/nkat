# Open questions for Mark Hendrix

Decisions that are **his**, which the 20 Aug 2026 call and "The Perfect Note"
do not settle. Each one says what we did in the meantime, so nothing is blocked
waiting on an answer.

Before the questions: the things the call **did** settle, so we don't ask him
twice.

---

## Already answered on the call — recorded, not asked

**A note must have HPI, social history, physical exam and vitals.** [05:55]:

> "each note that you have to have has an HPI, which is history of present
> illness, social history — and just kind of these typed-in texts. And then the
> rest is like a physical exam."

…and [06:29] "you're going to collect their vitals". All four are sections in
the shipped template.

All four block signing, and so does Assessment and plan. `DEFAULT_NOTE_SECTIONS`
in `lib/features/visits/note-template.ts` marks **HPI, social history, vitals,
physical exam and assessment and plan** required, and `transitionVisit` refuses
a sign-off that leaves any of them empty, naming the ones that are missing.

*One narrow thing does remain open, and it is ours to raise rather than his to
have answered:* not the list, but where each entry applies. Requiredness is per
visit type, because his four describe a **home** visit:

- **Vitals and physical exam** are waived on an advance-care-planning visit, on
  any visit with the telehealth box ticked whatever its type, and on a
  bereavement follow-up. There is no way to weigh a patient over the telephone,
  so requiring it would make the product refuse a legitimate encounter.
- **HPI and social history** are waived on a bereavement follow-up as well —
  that is a visit to the family after the patient has died, and the history of
  present illness is over.
- **Assessment and plan** has no exceptions.

Every waiver is a section that cannot be produced at all, never one that would
merely be inconvenient. The set is also per org: his org edits its own template
on Settings → Note template, and version 1 is what ships.

**Ask:** are those the right waivers? Vitals on a telehealth visit is the one
worth his answer — a family member can read them out, and some payers expect
them on the note regardless of how the visit happened.

**Codes are selected on total visit time.** [05:13]:

> "they look at the total number of minutes for that visit, and that's what
> determines the code that you have."

That is how Pallio codes. `code.mdm_level` exists as reference data but nothing
captures medical decision making from the clinician and nothing selects on it.
He described time-based selection as the norm and did not raise MDM. **Not a
question** unless he raises it; flagged here only so the choice is visible.

**Typing, not dictation — for now.** [03:19] he asked "is this manually typing,
voice-to-text?", was told we type, and accepted it ([03:44] "Yeah. Oh, yeah")
before moving to templates. He never asked for dictation. **Not an open
requirement** — worth revisiting only when he says so.

---

## 1. The referring physician on the claim

**The care-team header itself is no longer a question — it shipped.** Page 1 of
The Perfect Note carries five slots:

> Palliative Care Provider: · Primary Care Provider: · Referring Physician: ·
> Pulmonologist: · Oncologist:

The call never touched them ("referring", "physician", "primary care",
"oncolog", "pulmon" return nothing in the transcript), so we took the document
at its word and modelled them, which was the recommendation this section used
to be asking him to approve. Migration 0103 (audit R30) added three tables:
`external_provider` — the org's roster of outside clinicians, one row per NPI,
with specialty, practice, phone and fax; `patient_external_provider` — who each
one is to this patient (primary care, referring, specialist, other), at most one
primary care and one referring per patient, with a free-text label for the rest
so "Pulmonologist" and "Oncologist" are two labelled specialists rather than two
hard-coded slots; and `patient_contact` for family, caregivers and the
healthcare POA. They are edited on the patient chart and `careTeamHeaderRows`
in `note-render.ts` prints them into the note header and the audit packet, in
his order, with primary care and referring always shown — as "—" when none is
on file — because his header always carries both.

**What is still open is narrower, and it is billing.** The referring physician
is now on the chart and on the note. It is *not* on the claim: the exported
superbill carries the rendering provider and NPI (box 24J), the billing NPI
(box 33a) and the patient account number (box 26), and nothing for box 17 /
17b, the referring or ordering provider. Nothing in his document or the call
says whether his claims need it.

**Ask:** do his payers require the referring provider on the claim, and for
which services? If yes it is a small addition — the name and NPI are already on
the patient — but we should not add a claim field on a guess, and box 17 filled
with the wrong provider is worse than box 17 left empty.

## 2. Units

**Never mentioned by anyone.** No hit in the transcript for "pound",
"kilogram", "fahrenheit" or "celsius". His note's vitals line is
`BP 106/62. HR 62. RR 16.` — no weight and no temperature, so the document
states no units either.

**What we did.** Entry and display in US customary — pounds, inches,
Fahrenheit — inferred from ordinary US practice. Storage stays metric so the
arithmetic and any future interchange stay unambiguous.

**Ask:** confirm that is right, and say whether height should be inches or
feet-and-inches (5'10" rather than 70 in), which is how most US charts read.

## 3. Where the vitals trend belongs

**Never discussed.** He asked for the capability — [06:29] "keep track of their
vitals, their weight" — but not for a location.

**What we did.** A **Vitals** tab on the patient record: every visit's readings
newest-first by date of service, with the weight change since the first reading
computed rather than typed.

**Ask:** is the patient record right, or does he want the trend visible on the
visit note itself while documenting? The second is more work but more useful at
the bedside.

---

## Decisions we made and are confident about

Recorded so he can push back.

- **The time-attestation paragraph and next-visit line from his note are
  omitted**, per his own covering instruction that those sections are outdated.
  The ">50% of time in counselling" basis stopped being a valid way to select an
  office/outpatient E/M code with the 2021 revision, so we would have dropped it
  regardless.
- **Carry-forward is explicit and marked.** It is a button, never automatic; it
  only fills sections empty on this visit; it only looks backwards in time; and
  any section still unedited is labelled "carried forward · unedited" on the
  note. Silent note cloning is the most-cited E/M audit failure.
- **A visit cannot be signed with an empty note.** This closed a real hole —
  207 existing visits had been attested with no documentation at all.
