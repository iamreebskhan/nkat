/**
 * /referrals/new — a referral received (Level-1 doc:22, 0111).
 *
 * What intake takes down on the call or from the fax: who, from where, why,
 * and the insurance if it came with it. Demographics are completed at
 * admission, in the intake wizard, which starts from what is written here.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateReferralSchema } from "@/lib/features/referrals/referral.types";

interface PayerOption {
  id: string;
  name: string;
  states: string[];
}
interface Member {
  userId: string;
  fullName: string | null;
  email: string;
}

const START = {
  receivedOn: "",
  firstName: "",
  lastName: "",
  dateOfBirth: "",
  phone: "",
  sourceName: "",
  referringProviderName: "",
  referringProviderNpi: "",
  reason: "",
  primaryDiagnosisIcd10: "",
  payerId: "",
  memberId: "",
  assignedToUserId: "",
  notes: "",
};
type Form = typeof START;

export default function NewReferralPage() {
  const router = useRouter();
  // The practice's today, from the server: the received day starts on it and
  // cannot be later. The browser's own day can already be tomorrow there.
  const [today, setToday] = useState<string | null>(null);
  const [f, setF] = useState<Form>(START);
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [orgPayerIds, setOrgPayerIds] = useState<string[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // Sources already used, offered as the form is typed in so one practice is
  // not three spellings in the reports.
  const [sources, setSources] = useState<string[]>([]);
  const [issue, setIssue] = useState<{ path: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return;
        setPayers(d.data?.payers ?? []);
        setOrgPayerIds(d.data?.orgPayerIds ?? []);
      })
      .catch(() => {});
    fetch("/api/team/members?active=1")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setMembers(d.data?.rows ?? []);
      })
      .catch(() => {});
    fetch("/api/referrals?filter=all&limit=200")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return;
        const names = (d.data?.rows ?? []).map((r: { sourceName: string | null }) => r.sourceName).filter(Boolean);
        setSources([...new Set<string>(names)].sort());
        if (typeof d.data?.today === "string") {
          setToday(d.data.today);
          setF((x) => (x.receivedOn ? x : { ...x, receivedOn: d.data.today }));
        }
      })
      .catch(() => {});
  }, []);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setIssue(null);
  };
  const errorFor = (k: keyof Form) => (issue?.path === k ? issue.message : undefined);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // Empty inputs are left out: every field but the received day and the
    // name is optional on a referral.
    const body = Object.fromEntries(
      Object.entries(f)
        .map(([k, v]) => [k, k === "primaryDiagnosisIcd10" ? v.trim().toUpperCase() : v.trim()])
        .filter(([, v]) => v !== ""),
    );
    const parsed = CreateReferralSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      setIssue({ path: String(i.path[0] ?? ""), message: i.message });
      return;
    }
    if (today && parsed.data.receivedOn > today) {
      setIssue({ path: "receivedOn", message: `That is after today at the practice (${today}).` });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/referrals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Not saved.");
        return;
      }
      router.push(`/referrals/${d.data.id}`);
    } catch {
      setError("Network error — the referral may not have been saved. Check the board before trying again.");
    } finally {
      setSaving(false);
    }
  }

  const ours = payers.filter((p) => orgPayerIds.includes(p.id));
  const payerOption = (p: PayerOption) => (
    <option key={p.id} value={p.id}>
      {p.name}
      {p.states.length > 0 ? ` · ${p.states.join("/")}` : ""}
    </option>
  );

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <Link href="/referrals" className="text-xs text-slate-500 hover:underline">
          ← Referrals
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">New referral</h1>
        <p className="text-slate-600 mt-1">
          Who, from where and why. The rest of intake happens at admission, starting from this.
        </p>
      </header>

      <form onSubmit={save} noValidate className="space-y-4" aria-label="New referral">
        <Card>
          <CardHeader>
            <CardTitle>The person referred</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field id="rf-received" label="Received" required error={errorFor("receivedOn")}>
              <TextInput
                id="rf-received"
                type="date"
                value={f.receivedOn}
                max={today ?? undefined}
                onChange={set("receivedOn")}
                invalid={Boolean(errorFor("receivedOn"))}
              />
            </Field>
            <div />
            <Field id="rf-first" label="First name" required error={errorFor("firstName")}>
              <TextInput id="rf-first" value={f.firstName} onChange={set("firstName")} invalid={Boolean(errorFor("firstName"))} />
            </Field>
            <Field id="rf-last" label="Last name" required error={errorFor("lastName")}>
              <TextInput id="rf-last" value={f.lastName} onChange={set("lastName")} invalid={Boolean(errorFor("lastName"))} />
            </Field>
            <Field id="rf-dob" label="Date of birth" optional error={errorFor("dateOfBirth")}>
              <TextInput id="rf-dob" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} />
            </Field>
            <Field id="rf-phone" label="Phone" optional error={errorFor("phone")}>
              <TextInput id="rf-phone" type="tel" value={f.phone} onChange={set("phone")} invalid={Boolean(errorFor("phone"))} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Referral</CardTitle>
            <CardDescription>Where it came from, and why.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              id="rf-source"
              label="Source"
              optional
              explain="The practice, clinic or hospital that sent it. The reports count referrals by source."
              error={errorFor("sourceName")}
            >
              <TextInput id="rf-source" list="rf-sources" value={f.sourceName} onChange={set("sourceName")} />
              <datalist id="rf-sources">
                {sources.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field id="rf-provider" label="Referring provider" optional error={errorFor("referringProviderName")}>
              <TextInput id="rf-provider" value={f.referringProviderName} onChange={set("referringProviderName")} />
            </Field>
            <Field id="rf-npi" label="Referring provider NPI" optional error={errorFor("referringProviderNpi")}>
              <TextInput
                id="rf-npi"
                value={f.referringProviderNpi}
                onChange={set("referringProviderNpi")}
                className="tabular"
                invalid={Boolean(errorFor("referringProviderNpi"))}
              />
            </Field>
            <Field id="rf-icd" label="Primary diagnosis (ICD-10)" optional error={errorFor("primaryDiagnosisIcd10")}>
              <TextInput
                id="rf-icd"
                value={f.primaryDiagnosisIcd10}
                onChange={set("primaryDiagnosisIcd10")}
                placeholder="C34.90"
                className="font-mono text-sm uppercase"
                invalid={Boolean(errorFor("primaryDiagnosisIcd10"))}
              />
            </Field>
            <div className="md:col-span-2">
              <Field id="rf-reason" label="Reason for referral" optional error={errorFor("reason")}>
                <TextArea id="rf-reason" rows={3} maxLength={2000} value={f.reason} onChange={set("reason")} />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Insurance and follow-up</CardTitle>
            <CardDescription>If it came with the referral. Coverage is checked on the referral page.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field id="rf-payer" label="Insurance plan" optional error={errorFor("payerId")}>
              <Select id="rf-payer" value={f.payerId} onChange={set("payerId")}>
                <option value="">Not known yet</option>
                {ours.length === 0 ? (
                  payers.map(payerOption)
                ) : (
                  <>
                    <optgroup label="Your practice's payers">{ours.map(payerOption)}</optgroup>
                    <optgroup label="Other payers">
                      {payers.filter((p) => !orgPayerIds.includes(p.id)).map(payerOption)}
                    </optgroup>
                  </>
                )}
              </Select>
            </Field>
            <Field id="rf-member" label="Member ID" optional error={errorFor("memberId")}>
              <TextInput id="rf-member" value={f.memberId} onChange={set("memberId")} />
            </Field>
            {members.length > 0 && (
              <Field id="rf-assigned" label="Assigned to" optional explain="Who on intake is working this referral.">
                <Select id="rf-assigned" value={f.assignedToUserId} onChange={set("assignedToUserId")}>
                  <option value="">Nobody yet</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName ?? m.email}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="md:col-span-2">
              <Field id="rf-notes" label="Notes" optional error={errorFor("notes")}>
                <TextArea id="rf-notes" rows={2} maxLength={2000} value={f.notes} onChange={set("notes")} />
              </Field>
            </div>
          </CardContent>
        </Card>

        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Link href="/referrals">
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </Link>
          <Button type="submit" loading={saving}>
            Save referral
          </Button>
        </div>
      </form>
    </div>
  );
}
