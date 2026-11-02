/**
 * /settings/billing-provider — who the practice's claims bill as (0118;
 * Level-1 doc:67): legal name, NPI, EIN, taxonomy, the billing address and a
 * pay-to address when payment goes elsewhere. The claim export reads it.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { Field, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BillingAddress, BillingProviderView } from "@/lib/features/billing/billing-provider.service";

type AddressForm = { line1: string; line2: string; city: string; state: string; zip: string };
const EMPTY: AddressForm = { line1: "", line2: "", city: "", state: "", zip: "" };
const toForm = (a: BillingAddress | null): AddressForm =>
  a ? { line1: a.line1, line2: a.line2 ?? "", city: a.city, state: a.state, zip: a.zip } : { ...EMPTY };
const blank = (a: AddressForm) => !a.line1.trim() && !a.line2.trim() && !a.city.trim() && !a.state.trim() && !a.zip.trim();
const fromForm = (a: AddressForm) =>
  blank(a)
    ? null
    : {
        line1: a.line1.trim(), ...(a.line2.trim() && { line2: a.line2.trim() }), city: a.city.trim(),
        state: a.state.trim().toUpperCase(), zip: a.zip.trim(),
      };
const einShown = (e: string | null) => (e ? `${e.slice(0, 2)}-${e.slice(2)}` : "");

function AddressFields({ prefix, value, onChange }: { prefix: string; value: AddressForm; onChange: (a: AddressForm) => void }) {
  const set = (k: keyof AddressForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
      <div className="md:col-span-6">
        <Field id={`${prefix}-l1`} label="Street address" required>
          <TextInput id={`${prefix}-l1`} maxLength={120} value={value.line1} onChange={set("line1")} />
        </Field>
      </div>
      <div className="md:col-span-6">
        <Field id={`${prefix}-l2`} label="Suite, unit" optional>
          <TextInput id={`${prefix}-l2`} maxLength={120} value={value.line2} onChange={set("line2")} />
        </Field>
      </div>
      <div className="md:col-span-3">
        <Field id={`${prefix}-city`} label="City" required>
          <TextInput id={`${prefix}-city`} maxLength={80} value={value.city} onChange={set("city")} />
        </Field>
      </div>
      <div className="md:col-span-1">
        <Field id={`${prefix}-state`} label="State" required>
          <TextInput id={`${prefix}-state`} maxLength={2} value={value.state} onChange={set("state")} />
        </Field>
      </div>
      <div className="md:col-span-2">
        <Field id={`${prefix}-zip`} label="ZIP" required explain="Five digits, or nine (ZIP+4). Payers prefer ZIP+4 for the billing address.">
          <TextInput id={`${prefix}-zip`} inputMode="numeric" maxLength={10} value={value.zip} onChange={set("zip")} />
        </Field>
      </div>
    </div>
  );
}

export default function BillingProviderPage() {
  const [saved, setSaved] = useState<BillingProviderView | null>(null);
  const [f, setF] = useState({ legalName: "", npi: "", ein: "", taxonomyCode: "" });
  const [address, setAddress] = useState<AddressForm>({ ...EMPTY });
  const [payToDiffers, setPayToDiffers] = useState(false);
  const [payTo, setPayTo] = useState<AddressForm>({ ...EMPTY });
  const [referring, setReferring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback((v: BillingProviderView) => {
    setSaved(v);
    setF({ legalName: v.legalName ?? "", npi: v.npi ?? "", ein: einShown(v.ein), taxonomyCode: v.taxonomyCode ?? "" });
    setAddress(toForm(v.address));
    setPayToDiffers(v.payTo !== null);
    setPayTo(toForm(v.payTo));
    setReferring(v.claimReferringProvider);
  }, []);

  useEffect(() => {
    fetch("/api/settings/billing-provider")
      .then((r) => r.json())
      .then((d) => (d.success ? load(d.data) : setMsg(d.error ?? "Could not load the billing provider.")))
      .catch(() => setMsg("Network error."));
  }, [load]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
    setDone(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setDone(false);
    if (!f.legalName.trim()) return setMsg("Say the name claims bill under.");
    if (!/^\d{10}$/.test(f.npi.trim())) return setMsg("The NPI is 10 digits.");
    if (!blank(address) && (!address.line1.trim() || !address.city.trim() || !address.state.trim() || !address.zip.trim())) {
      return setMsg("The billing address needs a street, city, state and ZIP — or leave it all empty.");
    }
    if (payToDiffers && (!payTo.line1.trim() || !payTo.city.trim() || !payTo.state.trim() || !payTo.zip.trim())) {
      return setMsg("The pay-to address needs a street, city, state and ZIP.");
    }
    setBusy(true);
    try {
      const r = await fetch("/api/settings/billing-provider", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legalName: f.legalName.trim(),
          npi: f.npi.trim(),
          ein: f.ein.trim() || null,
          taxonomyCode: f.taxonomyCode.trim() || null,
          address: fromForm(address),
          payTo: payToDiffers ? fromForm(payTo) : null,
          claimReferringProvider: referring,
        }),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not saved.");
      load(d.data);
      setDone(true);
    } catch {
      setMsg("Network error — not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Billing provider</h1>
        <p className="text-slate-600 mt-1">
          Who the practice&rsquo;s claims bill as: CMS-1500 boxes 25 and 33. The claim export carries it to your billing software.
        </p>
      </header>

      {saved && saved.missing.length > 0 && (
        <p role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          A claim still needs: {saved.missing.join(", ")}.
        </p>
      )}

      <form onSubmit={save} noValidate className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>The organization, as the payers know it.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Field id="bp-name" label="Legal name" required>
                <TextInput id="bp-name" maxLength={120} value={f.legalName} onChange={set("legalName")} />
              </Field>
            </div>
            <Field id="bp-npi" label="Organization NPI" required explain="The billing provider's NPI (box 33a). Each clinician's own NPI is on the Team page.">
              <TextInput id="bp-npi" inputMode="numeric" maxLength={10} value={f.npi} onChange={set("npi")} />
            </Field>
            <Field id="bp-ein" label="EIN" recommended explain="The employer identification number the claims are billed under (box 25), as XX-XXXXXXX.">
              <TextInput id="bp-ein" inputMode="numeric" maxLength={10} placeholder="XX-XXXXXXX" value={f.ein} onChange={set("ein")} />
            </Field>
            <Field id="bp-tax" label="Taxonomy" recommended explain="The billing provider's Health Care Provider Taxonomy code, as registered on NPPES, e.g. 207RH0002X.">
              <TextInput id="bp-tax" maxLength={10} value={f.taxonomyCode} onChange={set("taxonomyCode")} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Billing address</CardTitle>
            <CardDescription>A street address: a PO box is refused for the billing provider.</CardDescription>
          </CardHeader>
          <CardContent>
            <AddressFields prefix="bp-addr" value={address} onChange={(a) => { setAddress(a); setMsg(null); setDone(false); }} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pay-to address</CardTitle>
            <CardDescription>Only when payment goes somewhere other than the billing address (a lockbox, say).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={payToDiffers}
                onChange={(e) => {
                  setPayToDiffers(e.target.checked);
                  setMsg(null);
                  setDone(false);
                }}
              />
              Payment goes to a different address
            </label>
            {payToDiffers && <AddressFields prefix="bp-pay" value={payTo} onChange={(a) => { setPayTo(a); setMsg(null); setDone(false); }} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Referring provider on claims</CardTitle>
            <CardDescription>Box 17 and 17b. Leave this off unless your payers ask for it: a wrong name in box 17 is worse than an empty box.</CardDescription>
          </CardHeader>
          <CardContent>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={referring}
                onChange={(e) => {
                  setReferring(e.target.checked);
                  setMsg(null);
                  setDone(false);
                }}
              />
              <span>
                Name the patient&rsquo;s referring physician on claims
                <span className="block text-xs text-slate-500">
                  From the chart&rsquo;s Care team, only with a valid NPI. Without one the box stays empty and the claim goes with a warning.
                </span>
              </span>
            </label>
          </CardContent>
        </Card>

        {msg && (
          <p role="alert" className="text-sm text-red-700">
            {msg}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-emerald-700">
            Saved.
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={!saved}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
