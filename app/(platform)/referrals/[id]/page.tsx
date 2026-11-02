/**
 * /referrals/[id] — one referral, from receipt to its disposition (Level-1
 * doc:22-28, 0111).
 *
 * Intake works it here: the details, the pending requirements, a coverage
 * check, and the move to a disposition — not taken under care with the
 * practice's reason code and day, set aside as pending long term, or
 * transitioned. Admission is completing intake for it: the wizard opens with
 * what was taken down and, when the patient is created, marks the referral
 * admitted on the same transaction. The nurse records triage here.
 */
"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { DocumentsCard } from "@/components/patients/documents-card";
import { CoverageCheckForm, CoverageCheckList } from "@/components/referrals/coverage-checks";
import { ReferralDetailsCard, RequirementsCard, TriageCard } from "@/components/referrals/referral-cards";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReasonCodeView } from "@/lib/features/referrals/reason-code.service";
import { REASON_CATEGORY_LABEL, reasonCodeText } from "@/lib/features/referrals/reason-codes";
import {
  REFERRAL_STAGE_LABEL,
  isOpenStage,
  stageMovesFrom,
  type ReferralStage,
  type ReferralView,
} from "@/lib/features/referrals/referral.types";

const STAGE_STYLE: Record<ReferralStage, string> = {
  pre_admission: "bg-sky-50 text-sky-900 ring-sky-600/30",
  pending_long_term: "bg-amber-50 text-amber-900 ring-amber-600/30",
  admitted: "bg-emerald-50 text-emerald-900 ring-emerald-600/30",
  ntuc: "bg-slate-100 text-slate-700 ring-slate-400/40",
  transitioned: "bg-violet-50 text-violet-900 ring-violet-600/30",
};

type Move = Exclude<ReferralStage, "admitted">;

/** What each move is called on its button, from where it starts. */
function moveLabel(to: Move, from: ReferralStage): string {
  if (to === "pre_admission") return isOpenStage(from) ? "Back to pre-admission" : "Reopen";
  if (to === "pending_long_term") return "Pending long term";
  if (to === "ntuc") return "Not taken under care";
  return "Transitioned";
}

const MOVE_HELP: Record<Move, string> = {
  pre_admission: "The referral is worked again from pre-admission. A closing reason and note are cleared.",
  pending_long_term: "Still a referral, set aside: the person is not ready to be admitted now.",
  ntuc: "Closes the referral with the practice's reason. The reports count it by its code.",
  transitioned: "Closes the referral as transitioned. Say where in the note.",
};

export default function ReferralPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [referral, setReferral] = useState<ReferralView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [move, setMove] = useState<Move | null>(null);
  const [recordingCheck, setRecordingCheck] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/referrals/${id}`);
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Referral not found.");
        return;
      }
      setError(null);
      setReferral(d.data);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setPerms(d.data?.permissions ?? []);
      })
      .catch(() => {});
  }, []);

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;
  if (error || !referral)
    return (
      <div className="px-8 py-8">
        <p role="alert" className="text-red-700">
          {error ?? "Referral not found."}
        </p>
        <Link href="/referrals" className="mt-4 inline-block text-[var(--color-brand-700)] underline">
          ← Back to referrals
        </Link>
      </div>
    );

  const r = referral;
  // Intake's grants move and correct a referral and check its coverage; the
  // clinical team's records triage — as the API routes gate them.
  const canReceive = perms.includes("patients.create");
  const canEdit = perms.includes("patients.edit");
  const canTriage = perms.includes("patient.acuity.edit");
  const open = isOpenStage(r.stage);
  const moves = stageMovesFrom(r.stage) as Move[];

  // What is still missing before admission. Shown, never enforced: the
  // practice's current EHR admits with requirements outstanding, and so may
  // the practice.
  const missing = [
    !r.triaged && "not triaged",
    !r.verification && "coverage not checked",
    r.verification && r.verification !== "active" && "coverage not confirmed active",
    r.requirementsOpen > 0 && `${r.requirementsOpen} requirement${r.requirementsOpen === 1 ? "" : "s"} open`,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="px-8 py-8 max-w-6xl">
      <header className="mb-6">
        <Link href="/referrals" className="text-xs text-slate-500 hover:underline">
          ← Referrals
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight">
              {r.lastName}, {r.firstName}
            </h1>
            <p className="text-slate-600 mt-1 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STAGE_STYLE[r.stage]}`}
              >
                {REFERRAL_STAGE_LABEL[r.stage]}
              </span>
              <span className="text-sm">
                Received {r.receivedOn} · {r.daysOpen} day{r.daysOpen === 1 ? "" : "s"}
                {open ? " open" : " to its disposition"}
                {r.sourceName ? ` · from ${r.sourceName}` : ""}
              </span>
            </p>
          </div>
          {canReceive && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {open && (
                <Link href={`/patients/new?referralId=${r.id}`}>
                  <Button>Admit — complete intake</Button>
                </Link>
              )}
              {moves.map((to) => (
                <Button
                  key={to}
                  variant="secondary"
                  aria-pressed={move === to}
                  onClick={() => setMove((m) => (m === to ? null : to))}
                >
                  {moveLabel(to, r.stage)}
                </Button>
              ))}
            </div>
          )}
          {r.stage === "admitted" && r.patientId && (
            <Link href={`/patients/${r.patientId}`}>
              <Button>Open the chart →</Button>
            </Link>
          )}
        </div>
        {canReceive && open && missing.length > 0 && (
          <p className="mt-2 text-xs text-amber-800 text-right">Before admitting: {missing.join(" · ")}.</p>
        )}
      </header>

      <Disposition referral={r} />

      {move && (
        <MovePanel
          key={move}
          referral={r}
          to={move}
          onCancel={() => setMove(null)}
          onMoved={async () => {
            setMove(null);
            await load();
          }}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          <ReferralDetailsCard
            referral={r}
            canEdit={canReceive && r.stage !== "admitted"}
            onSaved={() => void load()}
          />
          <RequirementsCard
            referral={r}
            canEdit={canReceive}
            onSaved={(requirements) =>
              setReferral((x) =>
                x
                  ? {
                      ...x,
                      requirements,
                      requirementsTotal: requirements.length,
                      requirementsOpen: requirements.filter((i) => !i.doneAt).length,
                    }
                  : x,
              )
            }
          />
          <DocumentsCard
            url={`/api/referrals/${r.id}/documents`}
            canEdit={canEdit && open}
            title="Paperwork"
            description={
              r.stage === "admitted"
                ? "Kept on the chart since admission."
                : "What came with the referral: the order, records, the face sheet. It moves to the chart at admission."
            }
            emptyText="None yet."
          />
        </div>
        <div className="space-y-4">
          <TriageCard referral={r} canTriage={canTriage} onSaved={() => void load()} />
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>Coverage checks</CardTitle>
                <CardDescription>
                  {r.stage === "admitted"
                    ? "These moved to the chart at admission. Record new checks there."
                    : "Each check of the insurance: how, what it said, and who made it."}
                </CardDescription>
              </div>
              {canEdit && open && !recordingCheck && (
                <Button variant="secondary" size="sm" onClick={() => setRecordingCheck(true)}>
                  Record a check
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {recordingCheck && (
                <CoverageCheckForm
                  postUrl={`/api/referrals/${r.id}/verifications`}
                  defaultPayerId={r.payerId}
                  defaultPayerName={r.payerName}
                  defaultMemberId={r.memberId}
                  onCancel={() => setRecordingCheck(false)}
                  onSaved={async () => {
                    setRecordingCheck(false);
                    await load();
                  }}
                />
              )}
              <CoverageCheckList checks={r.verifications} emptyText="Not checked yet." />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** The closing line of a referral that has one. */
function Disposition({ referral: r }: { referral: ReferralView }) {
  // The practice's days, as the received day is.
  let text: string | null = null;
  if (r.stage === "ntuc") text = `Not taken under care on ${r.ntucOn ?? "—"}: ${r.ntucReason ?? "no reason recorded"}.`;
  if (r.stage === "transitioned") text = `Transitioned on ${r.stageChangedOn}.`;
  if (r.stage === "pending_long_term") text = `Pending long term since ${r.stageChangedOn}.`;
  if (r.stage === "admitted") text = `Admitted on ${r.admittedOn ?? "—"}.`;
  if (!text) return null;
  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
      <p>
        {text}
        {r.stage === "admitted" && r.patientId && (
          <>
            {" "}
            <Link href={`/patients/${r.patientId}`} className="text-[var(--color-brand-700)] underline">
              Open the chart
            </Link>
          </>
        )}
      </p>
      {r.closedNote && <p className="mt-1 text-slate-600 whitespace-pre-wrap">{r.closedNote}</p>}
    </div>
  );
}

function MovePanel({
  referral: r,
  to,
  onCancel,
  onMoved,
}: {
  referral: ReferralView;
  to: Move;
  onCancel: () => void;
  onMoved: () => Promise<void>;
}) {
  // The practice's day, as the server checks the NTUC day against it.
  const today = r.practiceToday;
  const [codes, setCodes] = useState<ReasonCodeView[] | null>(null);
  const [reasonCodeId, setReasonCodeId] = useState("");
  const [on, setOn] = useState(today);
  const [note, setNote] = useState("");
  const [issue, setIssue] = useState<{ path: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (to !== "ntuc") return;
    let abandoned = false;
    fetch("/api/settings/reason-codes?kind=ntuc")
      .then((x) => x.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) setCodes(d.data.codes ?? []);
        else setError(d.error ?? "Could not load the NTUC reasons.");
      })
      .catch(() => {
        if (!abandoned) setError("Network error — the NTUC reasons did not load.");
      });
    return () => {
      abandoned = true;
    };
  }, [to]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (to === "ntuc") {
      if (!reasonCodeId) return setIssue({ path: "reasonCodeId", message: "Pick the reason." });
      if (!on) return setIssue({ path: "on", message: "Pick the day." });
      if (on > today) return setIssue({ path: "on", message: "The day is after today." });
      if (on < r.receivedOn) return setIssue({ path: "on", message: `The referral was received on ${r.receivedOn}.` });
    }
    const body =
      to === "ntuc"
        ? { to, reasonCodeId, on, ...(note.trim() && { note: note.trim() }) }
        : { to, ...(note.trim() && { note: note.trim() }) };
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/referrals/${r.id}/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "Not saved.");
        return;
      }
      await onMoved();
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  // The practice's codes by what the reports count them as.
  const groups = new Map<string, ReasonCodeView[]>();
  for (const c of codes ?? []) {
    const g = REASON_CATEGORY_LABEL[c.category];
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  return (
    <Card className="mb-4 ring-1 ring-[var(--color-brand-600)]/30">
      <CardHeader>
        <CardTitle>{moveLabel(to, r.stage)}</CardTitle>
        <CardDescription>{MOVE_HELP[to]}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label={moveLabel(to, r.stage)}>
          {to === "ntuc" && (
            <>
              <Field id="mv-reason" label="Reason" required error={issue?.path === "reasonCodeId" ? issue.message : undefined}>
                <Select
                  id="mv-reason"
                  value={reasonCodeId}
                  onChange={(e) => {
                    setReasonCodeId(e.target.value);
                    setIssue(null);
                  }}
                  invalid={issue?.path === "reasonCodeId"}
                  disabled={codes === null}
                >
                  <option value="" disabled>
                    {codes === null ? "Loading…" : "Choose the reason…"}
                  </option>
                  {[...groups].map(([label, list]) => (
                    <optgroup key={label} label={label}>
                      {list.map((c) => (
                        <option key={c.id} value={c.id}>
                          {reasonCodeText(c)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              <Field id="mv-on" label="Day" required error={issue?.path === "on" ? issue.message : undefined}>
                <TextInput
                  id="mv-on"
                  type="date"
                  value={on}
                  min={r.receivedOn}
                  max={today}
                  onChange={(e) => {
                    setOn(e.target.value);
                    setIssue(null);
                  }}
                  invalid={issue?.path === "on"}
                />
              </Field>
            </>
          )}
          <div className="md:col-span-2">
            <Field id="mv-note" label="Note" optional>
              <TextArea id="mv-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <div className="md:col-span-2 space-y-2">
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                {to === "pre_admission" && !isOpenStage(r.stage) ? "Reopen" : "Save"}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
