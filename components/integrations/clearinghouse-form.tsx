/**
 * Setting up or editing a clearinghouse connection (0120): the IDs the files
 * carry, how claim files travel (SFTP, or download and upload by hand), and
 * how real-time checks are asked (CAQH CORE, or Availity's API).
 *
 * Starts from the vendor's profile (lib/features/clearinghouse/vendors.ts),
 * each default saying where it came from behind its ⓘ: the vendor's own
 * guide, a third party's (confirm it), or the practice's enrollment.
 *
 * SECRETS are write-only. A saved password shows as "saved"; typing replaces
 * it, "Remove" clears it, leaving it blank keeps it. Nothing secret is ever
 * read back into this form.
 */
"use client";

import { useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import {
  connectionProblems,
  ConnectionInputSchema,
  defaultSettings,
  ID_QUALIFIERS,
  type ConnectionSecrets,
  type ConnectionSettings,
} from "@/lib/features/clearinghouse/connection-settings";
import type { ConnectionView } from "@/lib/features/clearinghouse/connection.service";
import {
  DEFAULT_SOURCE_LABELS,
  VENDOR_PROFILES,
  type ClearinghouseVendor,
  type VendorDefault,
} from "@/lib/features/clearinghouse/vendors";

type SecretKey = "sftpPassword" | "sftpPrivateKey" | "sftpPassphrase" | "corePassword" | "apiClientSecret";

const SECRET_LABEL: Record<SecretKey, string> = {
  sftpPassword: "SFTP password",
  sftpPrivateKey: "SSH private key",
  sftpPassphrase: "Key passphrase",
  corePassword: "CORE password",
  apiClientSecret: "Client secret",
};

function source(d: VendorDefault<unknown> | undefined): string | undefined {
  if (!d) return undefined;
  return `${DEFAULT_SOURCE_LABELS[d.source]}${d.note ? ` — ${d.note}` : ""}`;
}

export function ClearinghouseForm({
  vendor,
  existing,
  onSaved,
  onCancel,
}: {
  vendor: ClearinghouseVendor;
  existing: ConnectionView | null;
  onSaved: (c: ConnectionView) => void;
  onCancel: () => void;
}) {
  const profile = VENDOR_PROFILES[vendor];
  const [label, setLabel] = useState(existing?.label ?? `${profile.name} (test)`);
  const [environment, setEnvironment] = useState<"test" | "production">(existing?.environment ?? "test");
  const [batchChannel, setBatchChannel] = useState<"sftp" | "manual">(existing?.batchChannel ?? "sftp");
  const [realtimeChannel, setRealtimeChannel] = useState<"none" | "core_soap" | "availity_api">(
    existing?.realtimeChannel ?? (profile.realtime.channels[0] ?? "none"),
  );
  const [isPrimary, setIsPrimary] = useState(existing?.isPrimary ?? false);
  const [s, setS] = useState<ConnectionSettings>(() => {
    const base = existing?.settings ?? defaultSettings(vendor, "test");
    const d = defaultSettings(vendor, existing?.environment ?? "test");
    // A saved connection may have no SFTP, CORE or API block; the form keeps
    // the vendor's defaults ready in case the channel is switched on.
    return { ...base, sftp: base.sftp ?? d.sftp, core: base.core ?? d.core, availityApi: base.availityApi ?? d.availityApi };
  });
  const [secrets, setSecrets] = useState<Record<SecretKey, string>>({
    sftpPassword: "", sftpPrivateKey: "", sftpPassphrase: "", corePassword: "", apiClientSecret: "",
  });
  const [cleared, setCleared] = useState<Record<SecretKey, boolean>>({
    sftpPassword: false, sftpPrivateKey: false, sftpPassphrase: false, corePassword: false, apiClientSecret: false,
  });
  const [downloadDirs, setDownloadDirs] = useState((s.sftp?.downloadDirs ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const set = (patch: Partial<ConnectionSettings>) => setS((cur) => ({ ...cur, ...patch }));
  const setSubmitter = (patch: Partial<ConnectionSettings["submitter"]>) => setS((cur) => ({ ...cur, submitter: { ...cur.submitter, ...patch } }));
  const setReceiver = (patch: Partial<ConnectionSettings["receiver"]>) => setS((cur) => ({ ...cur, receiver: { ...cur.receiver, ...patch } }));
  const setSftp = (patch: Partial<NonNullable<ConnectionSettings["sftp"]>>) =>
    setS((cur) => ({ ...cur, sftp: { ...(cur.sftp ?? defaultSettings(vendor, environment).sftp!), ...patch } }));
  const setCore = (patch: Partial<NonNullable<ConnectionSettings["core"]>>) =>
    setS((cur) => ({ ...cur, core: { url: "", username: "", senderId: "", receiverId: "", ...(cur.core ?? {}), ...patch } }));
  const setApi = (patch: Partial<NonNullable<ConnectionSettings["availityApi"]>>) =>
    setS((cur) => ({ ...cur, availityApi: { baseUrl: "", clientId: "", scope: "hipaa", mockScenario: null, ...(cur.availityApi ?? {}), ...patch } }));

  /** Switching test ↔ production moves a host still at the vendor's default to the other one. */
  function changeEnvironment(next: "test" | "production") {
    const was = profile.sftp.host[environment].value;
    const wasCore = profile.realtime.coreUrl[environment].value;
    setEnvironment(next);
    if (s.sftp && s.sftp.host === was) setSftp({ host: profile.sftp.host[next].value });
    if (s.core && s.core.url === wasCore) setCore({ url: profile.realtime.coreUrl[next].value });
    if (label === `${profile.name} (${environment})`) setLabel(`${profile.name} (${next})`);
  }

  const saved = (k: SecretKey) => Boolean(existing?.secretsSaved[k]) && !cleared[k];

  function secretField(k: SecretKey, opts: { multiline?: boolean; required?: boolean } = {}) {
    const id = `ch-${k}`;
    return (
      <Field
        id={id}
        label={SECRET_LABEL[k]}
        required={opts.required && !saved(k)}
        optional={!opts.required}
        explain={saved(k) ? "Saved, encrypted. Leave blank to keep it, type to replace it." : "Stored encrypted; never shown again after saving."}
      >
        {opts.multiline ? (
          <TextArea
            id={id}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            placeholder={saved(k) ? "Saved — leave blank to keep" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            value={secrets[k]}
            onChange={(e) => setSecrets((cur) => ({ ...cur, [k]: e.target.value }))}
          />
        ) : (
          <TextInput
            id={id}
            type="password"
            autoComplete="new-password"
            placeholder={saved(k) ? "Saved — leave blank to keep" : ""}
            value={secrets[k]}
            onChange={(e) => setSecrets((cur) => ({ ...cur, [k]: e.target.value }))}
          />
        )}
        {saved(k) && (
          <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => setCleared((cur) => ({ ...cur, [k]: true }))}>
            Remove the saved {SECRET_LABEL[k].toLowerCase()}
          </button>
        )}
      </Field>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const settings: ConnectionSettings = {
      ...s,
      sftp: batchChannel === "sftp" && s.sftp
        ? { ...s.sftp, downloadDirs: downloadDirs.split(",").map((x) => x.trim()).filter(Boolean) }
        : null,
      core: realtimeChannel === "core_soap" ? s.core : null,
      availityApi: realtimeChannel === "availity_api" ? s.availityApi : null,
    };
    const patch: Partial<Record<SecretKey, string | null>> = {};
    for (const k of Object.keys(secrets) as SecretKey[]) {
      if (secrets[k].trim()) patch[k] = k === "sftpPrivateKey" ? secrets[k] : secrets[k].trim();
      else if (cleared[k]) patch[k] = null;
    }
    const input = { vendor, label, environment, batchChannel, realtimeChannel, isPrimary, settings, secrets: patch };
    const parsed = ConnectionInputSchema.safeParse(input);
    if (!parsed.success) {
      setMsg(parsed.error.issues[0]?.message ?? "Some fields need a look: check the ones marked required.");
      return;
    }
    // What the channels need beyond the fields, counting secrets already saved.
    const willHave: ConnectionSecrets = {};
    for (const k of Object.keys(secrets) as SecretKey[]) {
      if (patch[k] || (patch[k] !== null && existing?.secretsSaved[k])) willHave[k] = "set";
    }
    const problems = connectionProblems({ vendor, batchChannel, realtimeChannel, settings: parsed.data.settings, secrets: willHave });
    if (problems.length > 0) {
      setMsg(problems.map((p) => `• ${p}`).join("\n"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(existing ? `/api/integrations/clearinghouses/${existing.id}` : "/api/integrations/clearinghouses", {
        method: existing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const d = await r.json();
      if (!d.success) {
        setMsg(d.error ?? "The connection wasn't saved. Try again.");
        return;
      }
      onSaved(d.data as ConnectionView);
    } catch {
      setMsg("Couldn't reach Pallio, so nothing was saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const realtimeChoices = profile.realtime.channels;
  return (
    <form onSubmit={save} noValidate className="space-y-6">
      {/* What to have to hand comes first: the fields below are copied from it. */}
      <details open={!existing} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium text-slate-800">What to get from {profile.name} before you start</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-700">
          {profile.setupSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="md:col-span-2">
          <Field id="ch-label" label="Name" required explain="How this connection is named on the billing screens.">
            <TextInput id="ch-label" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </div>
        <Field
          id="ch-env"
          label="Environment"
          required
          explain={`Test files go to ${profile.name}'s test system and never reach a payer, so claims sent on a test connection stay as they are. Switch to Production once ${profile.name} approves you. (Marked T or P in ISA15.)`}
        >
          <Select id="ch-env" value={environment} onChange={(e) => changeEnvironment(e.target.value as "test" | "production")}>
            <option value="test">Test</option>
            <option value="production">Production</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm md:col-span-3">
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          Use as the default clearinghouse: claims and checks go here unless someone picks another
        </label>
      </section>

      <section>
        <h3 className="mb-2 font-medium text-slate-800">Your IDs</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field id="ch-sub-id" label={profile.submitterIdLabel} required explain={`${profile.submitterIdHint} Sent in ISA06, GS02 and loop 1000A.`}>
            <TextInput id="ch-sub-id" maxLength={15} value={s.submitter.id} onChange={(e) => setSubmitter({ id: e.target.value })} />
          </Field>
          <Field id="ch-sub-name" label="Submitter name" required explain="The practice's name as the clearinghouse knows it (1000A NM103).">
            <TextInput id="ch-sub-name" maxLength={60} value={s.submitter.name} onChange={(e) => setSubmitter({ name: e.target.value })} />
          </Field>
          <Field id="ch-contact" label="Contact name" required explain="Who the clearinghouse calls about a file (1000A PER).">
            <TextInput id="ch-contact" maxLength={60} value={s.submitter.contactName} onChange={(e) => setSubmitter({ contactName: e.target.value })} />
          </Field>
          <Field id="ch-phone" label="Contact phone" optional explain="Ten digits. A phone or an email is required.">
            <TextInput id="ch-phone" inputMode="tel" maxLength={30} value={s.submitter.contactPhone ?? ""} onChange={(e) => setSubmitter({ contactPhone: e.target.value || null })} />
          </Field>
          <Field id="ch-email" label="Contact email" optional>
            <TextInput id="ch-email" type="email" maxLength={80} value={s.submitter.contactEmail ?? ""} onChange={(e) => setSubmitter({ contactEmail: e.target.value || null })} />
          </Field>
          <Field id="ch-sq" label="Your ID qualifier" required explain={source(profile.senderQualifier) ?? "ISA05: ZZ (mutually defined) unless the vendor says otherwise."}>
            <Select id="ch-sq" value={s.senderQualifier} onChange={(e) => set({ senderQualifier: e.target.value as ConnectionSettings["senderQualifier"] })}>
              {ID_QUALIFIERS.map((q) => (
                <option key={q} value={q}>{q}</option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-medium text-slate-800">{profile.name}&rsquo;s IDs</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field id="ch-rq" label="Receiver qualifier" required explain={`ISA07. ${source(profile.receiverQualifier) ?? ""}`}>
            <Select id="ch-rq" value={s.receiver.qualifier} onChange={(e) => setReceiver({ qualifier: e.target.value as ConnectionSettings["receiver"]["qualifier"] })}>
              {ID_QUALIFIERS.map((q) => (
                <option key={q} value={q}>{q}</option>
              ))}
            </Select>
          </Field>
          <Field id="ch-rid" label="Receiver ID" required explain={`ISA08. ${source(profile.receiverId) ?? ""}`}>
            <TextInput id="ch-rid" maxLength={15} value={s.receiver.id} onChange={(e) => setReceiver({ id: e.target.value })} />
          </Field>
          <Field id="ch-gs" label="Receiver code" required explain={`GS03. ${source(profile.gsReceiverCode) ?? ""}`}>
            <TextInput id="ch-gs" maxLength={15} value={s.receiver.gsCode} onChange={(e) => setReceiver({ gsCode: e.target.value })} />
          </Field>
          <Field id="ch-rname" label="Receiver name" required explain={`Loop 1000B NM103. ${source(profile.receiverName) ?? ""}`}>
            <TextInput id="ch-rname" maxLength={60} value={s.receiver.name} onChange={(e) => setReceiver({ name: e.target.value })} />
          </Field>
          <Field id="ch-r1000b" label="Receiver ID in the claim" required explain={`Loop 1000B NM109. ${source(profile.loop1000BId) ?? ""}`}>
            <TextInput id="ch-r1000b" maxLength={80} value={s.receiver.loop1000BId} onChange={(e) => setReceiver({ loop1000BId: e.target.value })} />
          </Field>
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-medium text-slate-800">Claim files</h3>
        <div className="mb-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="ch-batch" checked={batchChannel === "sftp"} onChange={() => setBatchChannel("sftp")} />
            Pallio sends and fetches them over SFTP
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="ch-batch" checked={batchChannel === "manual"} onChange={() => setBatchChannel("manual")} />
            I download the 837P and upload the responses myself
          </label>
        </div>
        {batchChannel === "sftp" && s.sftp && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <Field id="ch-host" label="SFTP host" required explain={source(profile.sftp.host[environment])}>
                <TextInput id="ch-host" maxLength={253} value={s.sftp.host} onChange={(e) => setSftp({ host: e.target.value.trim() })} />
              </Field>
            </div>
            <Field id="ch-port" label="Port" required explain={source(profile.sftp.port)}>
              <TextInput id="ch-port" inputMode="numeric" maxLength={5} value={String(s.sftp.port)} onChange={(e) => setSftp({ port: Number(e.target.value) || 0 })} />
            </Field>
            <div className="md:col-span-3">
              <Field id="ch-user" label="SFTP user" required explain={profile.sftp.usernameHint}>
                <TextInput id="ch-user" autoComplete="off" maxLength={100} value={s.sftp.username} onChange={(e) => setSftp({ username: e.target.value })} />
              </Field>
            </div>
            {secretField("sftpPassword", { required: !secrets.sftpPrivateKey && !saved("sftpPrivateKey") })}
            <div className="md:col-span-2">{secretField("sftpPrivateKey", { multiline: true })}</div>
            {(secrets.sftpPrivateKey || saved("sftpPrivateKey")) && secretField("sftpPassphrase")}
            <Field id="ch-up" label="Upload folder" required={vendor === "availity"} optional={vendor !== "availity"} explain={source(profile.sftp.uploadDir) ?? "Empty = the SFTP user's home folder."}>
              <TextInput id="ch-up" maxLength={200} value={s.sftp.uploadDir} onChange={(e) => setSftp({ uploadDir: e.target.value })} />
            </Field>
            <Field id="ch-down" label="Download folders" required explain={`${source(profile.sftp.downloadDirs) ?? ""} Separate several with commas.`}>
              <TextInput id="ch-down" maxLength={600} value={downloadDirs} onChange={(e) => setDownloadDirs(e.target.value)} />
            </Field>
            <Field id="ch-ext" label="File extension" required explain={source(profile.sftp.fileExtension)}>
              <Select id="ch-ext" value={s.sftp.fileExtension} onChange={(e) => setSftp({ fileExtension: e.target.value as ".txt" })}>
                {[".txt", ".837", ".x12", ".dat", ".edi"].map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </Select>
            </Field>
            {profile.sftp.notificationsInUploadDir && (
              <label className="flex items-center gap-2 text-sm md:col-span-3">
                <input type="checkbox" checked={s.sftp.notificationsInUploadDir} onChange={(e) => setSftp({ notificationsInUploadDir: e.target.checked })} />
                Read {profile.name}&rsquo;s &ldquo;-success&rdquo; / &ldquo;-FAILED&rdquo; notices from the upload folder
              </label>
            )}
            {existing?.hostKeySha256 && (
              <p className="text-xs text-slate-500 md:col-span-3">
                Host key recorded: <span className="font-mono">SHA256:{existing.hostKeySha256}</span>. A server presenting another key is refused.
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-medium text-slate-800">Real-time eligibility and claim status</h3>
        <div className="mb-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="ch-rt" checked={realtimeChannel === "none"} onChange={() => setRealtimeChannel("none")} />
            None
          </label>
          {realtimeChoices.includes("core_soap") && (
            <label className="flex items-center gap-2">
              <input type="radio" name="ch-rt" checked={realtimeChannel === "core_soap"} onChange={() => setRealtimeChannel("core_soap")} />
              CAQH CORE (270/271, 276/277)
            </label>
          )}
          {realtimeChoices.includes("availity_api") && (
            <label className="flex items-center gap-2">
              <input type="radio" name="ch-rt" checked={realtimeChannel === "availity_api"} onChange={() => setRealtimeChannel("availity_api")} />
              Availity&rsquo;s API
            </label>
          )}
        </div>
        {realtimeChannel === "core_soap" && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field id="ch-core-url" label="CORE endpoint" required explain={source(profile.realtime.coreUrl[environment])}>
                <TextInput id="ch-core-url" maxLength={300} value={s.core?.url ?? ""} onChange={(e) => setCore({ url: e.target.value.trim() })} />
              </Field>
            </div>
            <Field id="ch-core-user" label="CORE user" required>
              <TextInput id="ch-core-user" autoComplete="off" maxLength={100} value={s.core?.username ?? ""} onChange={(e) => setCore({ username: e.target.value })} />
            </Field>
            {secretField("corePassword", { required: true })}
            <Field id="ch-core-sid" label="CORE sender ID" required explain="Usually the same as your submitter ID.">
              <TextInput id="ch-core-sid" maxLength={50} value={s.core?.senderId ?? ""} onChange={(e) => setCore({ senderId: e.target.value })} />
            </Field>
            <Field id="ch-core-rid" label="CORE receiver ID" required explain="Usually the same as the receiver ID (ISA08).">
              <TextInput id="ch-core-rid" maxLength={50} value={s.core?.receiverId ?? ""} onChange={(e) => setCore({ receiverId: e.target.value })} />
            </Field>
          </div>
        )}
        {realtimeChannel === "availity_api" && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field id="ch-api-url" label="API base URL" required explain={source(profile.realtime.apiBaseUrl)}>
                <TextInput id="ch-api-url" maxLength={300} value={s.availityApi?.baseUrl ?? ""} onChange={(e) => setApi({ baseUrl: e.target.value.trim() })} />
              </Field>
            </div>
            <Field id="ch-api-id" label="Client ID" required explain="From your app on developer.availity.com (Apps).">
              <TextInput id="ch-api-id" autoComplete="off" maxLength={200} value={s.availityApi?.clientId ?? ""} onChange={(e) => setApi({ clientId: e.target.value.trim() })} />
            </Field>
            {secretField("apiClientSecret", { required: true })}
            <Field id="ch-api-mock" label="Demo scenario" optional explain="Demo plans only: the canned answer Availity returns (for example Coverages-Complete-i). Leave empty for live data.">
              <TextInput id="ch-api-mock" maxLength={80} value={s.availityApi?.mockScenario ?? ""} onChange={(e) => setApi({ mockScenario: e.target.value.trim() || null })} />
            </Field>
            <Field id="ch-elig-st" label="Eligibility service type" required explain="EQ01 / serviceType: 30 asks about plan coverage as a whole.">
              <TextInput id="ch-elig-st" maxLength={2} value={s.eligibilityServiceType} onChange={(e) => set({ eligibilityServiceType: e.target.value.toUpperCase() })} />
            </Field>
          </div>
        )}
      </section>

      {msg && <p role="alert" className="whitespace-pre-line text-sm text-red-700">{msg}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}>{existing ? "Save changes" : `Save ${profile.name} connection`}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
