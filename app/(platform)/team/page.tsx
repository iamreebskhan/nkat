/**
 * /team — invite + permission editor.
 *
 * Source: pallio_complete_vision_v3 §18.7. Org admin selects role
 * template → permissions populate → toggle individual permissions
 * before sending.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  CLINICIAN_CREDENTIALS,
  CREDENTIAL_LABEL,
  isValidNpi,
  type ClinicianCredential,
} from "@/lib/features/team/clinician";
import {
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_TEMPLATES,
  type RoleTemplate,
} from "@/lib/features/team/team.types";

const ALL_PERMISSIONS = Array.from(
  new Set(
    Object.values(ROLE_DEFAULT_PERMISSIONS).flat(),
  ),
).sort();

interface InviteRow {
  id: string;
  email: string;
  roleTemplate: RoleTemplate;
  expiresAt: string;
  createdAt: string;
  permissions: string[];
}

interface MemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  permissions: string[];
  /** Individual NPI — the rendering provider on this person's claims. */
  npi: string | null;
  /** Licensure — sets the rate this person's claims are priced at. */
  credential: string | null;
}

type Tab = "members" | "invites" | "new";

export default function TeamPage() {
  const [tab, setTab] = useState<Tab>("members");
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [reloadKey, setReloadKey] = useState(0);
  function reload() {
    setReloadKey((k) => k + 1);
  }

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [m, i] = await Promise.all([
          // active=1: every row here gets an Edit button, and the permission
          // editor refuses (404) anyone who is not an active member. This page
          // has no way to reactivate anyone, so a suspended row would offer an
          // edit that always fails. Until it can, the roster lists exactly the
          // people it can actually edit, and the header says "active".
          fetch("/api/team/members?active=1").then((r) => r.json()),
          fetch("/api/team/invites").then((r) => r.json()),
        ]);
        if (abandoned) return;
        if (m.success) setMembers(m.data.rows ?? []);
        if (i.success) setInvites(i.data.rows ?? []);
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [reloadKey]);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Team</h1>
          {/* "active" is not decoration: this is the same count a seat limit
              is measured against (org_member.status = 'active'), and it is
              exactly the list below. An unqualified "N members" would start
              drifting from the seat number the day a member can be
              deactivated. */}
          <p className="text-slate-600 mt-1">
            {members.length} active member{members.length === 1 ? "" : "s"} ·{" "}
            {invites.length} pending invite{invites.length === 1 ? "" : "s"}
          </p>
        </div>
        {/* Primary action up top, not buried in a tab (walkthrough 05:16). */}
        <Button onClick={() => setTab("new")}>Invite new member</Button>
      </header>

      <div className="flex gap-2 mb-4 border-b border-slate-200">
        {(["members", "invites", "new"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t
                ? "border-[var(--color-brand-700)] text-[var(--color-brand-700)]"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t === "new" ? "Invite" : t}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {!loading && tab === "members" && (
        <MembersTable rows={members} onChange={reload} />
      )}
      {!loading && tab === "invites" && <InvitesTable rows={invites} />}
      {!loading && tab === "new" && <InviteForm onCreated={() => { setTab("invites"); void reload(); }} />}
    </div>
  );
}

function MembersTable({ rows, onChange }: { rows: MemberRow[]; onChange: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [perms, setPerms] = useState<string[]>([]);
  // Billing identity (audit R40, R25): what this person's claims name as
  // rendering provider, and the rate they are priced at.
  const [npi, setNpi] = useState("");
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function startEdit(r: MemberRow) {
    setEditing(r.userId);
    setPerms(r.permissions);
    setNpi(r.npi ?? "");
    setCredential(r.credential ?? "");
    setError(null);
    setNotice(null);
  }

  async function save(userId: string) {
    setSaving(true);
    setError(null);
    try {
      // Billing identity first: a mistyped NPI is refused with a reason, and
      // the editor stays open with nothing else changed until it is fixed.
      const pr = await fetch(`/api/team/members/${userId}/profile`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npi: npi.trim() || null, credential: credential || null }),
      });
      const pd = await pr.json();
      if (!pd.success) {
        setError(pd.error ?? "Could not save the NPI and credential.");
        return;
      }
      // This response used to be ignored, so a refused save looked like a
      // successful one.
      const res = await fetch(`/api/team/members/${userId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: perms }),
      });
      if (!res.ok) {
        const rd = await res.json().catch(() => null);
        setError(rd?.error ?? "Could not save the permissions.");
        return;
      }
      const n = Number(pd.data?.openBillsUpdated ?? 0);
      setNotice(
        n > 0
          ? `Saved. ${n} open bill${n === 1 ? " now carries" : "s now carry"} this NPI as rendering provider.`
          : "Saved.",
      );
      setEditing(null);
      onChange();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  const npiLooksWrong = npi.length === 10 && !isValidNpi(npi);
  // Clearing every box is a save the server refuses (PERMISSION_SET_REQUIRED),
  // so don't offer the gesture: the admin used to be able to press Save, watch
  // it fail, and have no idea why the button was there at all.
  const nothingTicked = perms.length === 0;

  return (
    <Card>
      <CardContent className="p-0">
        {notice && (
          <div
            role="status"
            className="px-4 py-2 text-sm text-emerald-800 bg-emerald-50 border-b border-emerald-100"
          >
            {notice}
          </div>
        )}
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-slate-500">No active members.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">User</th>
                <th className="text-left font-semibold px-4 py-2.5">Credential</th>
                <th className="text-left font-semibold px-4 py-2.5">NPI</th>
                <th className="text-right font-semibold px-4 py-2.5">Permissions</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((m) => (
                <tr key={m.userId}>
                  <td className="px-4 py-2">
                    <div className="font-medium">{m.fullName ?? m.email}</div>
                    <div className="text-xs text-slate-500">{m.email}</div>
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {m.credential ? (
                      (CREDENTIAL_LABEL[m.credential as ClinicianCredential] ?? m.credential)
                    ) : (
                      <span className="text-slate-400">Not set</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {m.npi ? (
                      <span className="font-mono text-xs tabular">{m.npi}</span>
                    ) : (
                      <span className="text-xs text-slate-400">Not recorded</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-slate-600 tabular">
                    {m.permissions.length}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {editing === m.userId ? (
                      <div className="space-y-1">
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={saving || nothingTicked}
                            onClick={() => save(m.userId)}
                          >
                            {saving ? "Saving…" : "Save"}
                          </Button>
                        </div>
                        {/* The reason sits at the button, not only in the panel
                            below — that is where the admin is looking when Save
                            does not respond. */}
                        {nothingTicked && (
                          <p className="text-[11px] text-amber-800">
                            Tick at least one permission to save.
                          </p>
                        )}
                      </div>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => startEdit(m)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editing && (
          <div className="px-4 py-4 border-t border-slate-200 bg-slate-50 space-y-4">
            <div>
              <p className="text-xs font-medium text-slate-700">Billing identity</p>
              <p className="text-xs text-slate-500 mt-0.5 mb-2">
                The NPI is what this person&apos;s claims name as rendering provider. The
                credential sets the rate they are priced at.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-xl">
                <label className="block">
                  <span className="block text-xs font-medium text-slate-700 mb-1">Credential</span>
                  <select
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
                  >
                    <option value="">Not set</option>
                    {CLINICIAN_CREDENTIALS.map((c) => (
                      <option key={c} value={c}>
                        {CREDENTIAL_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-slate-700 mb-1">
                    Individual NPI
                  </span>
                  <input
                    inputMode="numeric"
                    value={npi}
                    // Digits only, capped at ten AFTER stripping. A maxLength
                    // here truncated a pasted "12345-67890" to ten characters
                    // first, and the last digit was silently lost.
                    onChange={(e) => setNpi(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
                    placeholder="10 digits"
                    aria-invalid={npiLooksWrong}
                    className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono tabular"
                  />
                </label>
              </div>
              {npiLooksWrong && (
                <p className="text-xs text-red-700 mt-1">
                  The last digit doesn&apos;t match the NPI check digit — check it against NPPES.
                </p>
              )}
            </div>
            {error && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
                {error}
              </div>
            )}
            <div>
              <p className="text-xs font-medium mb-2 text-slate-700">
                Permissions ({perms.length})
              </p>
              {nothingTicked && (
                <p className="text-xs text-amber-800 mb-2">
                  Save is off until at least one permission is ticked. A member with
                  none can still sign in but open nothing — leave them the one they
                  still need.
                </p>
              )}
              <PermissionGrid value={perms} onChange={setPerms} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InvitesTable({ rows }: { rows: InviteRow[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-slate-500">No pending invites.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">Email</th>
                <th className="text-left font-semibold px-4 py-2.5">Role</th>
                <th className="text-right font-semibold px-4 py-2.5">Permissions</th>
                <th className="text-right font-semibold px-4 py-2.5">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-2 font-medium">{i.email}</td>
                  <td className="px-4 py-2 text-slate-700">{i.roleTemplate.replace("_", " ")}</td>
                  <td className="px-4 py-2 text-right tabular">{i.permissions.length}</td>
                  <td className="px-4 py-2 text-right text-xs text-slate-500 tabular">
                    {i.expiresAt.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function InviteForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [roleTemplate, setRoleTemplate] = useState<RoleTemplate>("clinician");
  const [perms, setPerms] = useState<string[]>(ROLE_DEFAULT_PERMISSIONS.clinician);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undelivered, setUndelivered] = useState<{ email: string; url: string } | null>(null);

  function changeRole(r: RoleTemplate) {
    setRoleTemplate(r);
    setPerms(ROLE_DEFAULT_PERMISSIONS[r]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/team/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, roleTemplate, permissions: perms }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!data.success) {
      setError(data.error ?? "Invite failed.");
      return;
    }
    setEmail("");
    // If outbound email is not configured the invite still exists and its link
    // still works — the colleague just never hears about it. Say so, and hand
    // over the link rather than leaving the admin to discover the silence a
    // week later.
    if (data.data?.emailDelivered === false && data.data?.acceptUrl) {
      setUndelivered({ email, url: data.data.acceptUrl });
    } else {
      setUndelivered(null);
    }
    onCreated();
  }

  return (
    <Card>
      <CardContent className="p-6">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">Email</span>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">Role template</span>
              <select
                value={roleTemplate}
                onChange={(e) => changeRole(e.target.value as RoleTemplate)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                {ROLE_TEMPLATES.map((r) => (
                  <option key={r} value={r}>
                    {r.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <p className="text-xs font-medium mb-2 text-slate-700">
              Permissions ({perms.length})
            </p>
            {perms.length === 0 && (
              <p className="text-xs text-amber-800 mb-2">
                {roleTemplate === "consultant"
                  ? "Consultants start with no access — tick what this engagement needs."
                  : "Pick at least one permission."}
              </p>
            )}
            <PermissionGrid value={perms} onChange={setPerms} />
          </div>
          {error && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}
          {undelivered && (
            <div className="text-sm text-amber-900 bg-amber-50 ring-1 ring-inset ring-amber-600/20 px-3 py-2 rounded space-y-1">
              <p className="font-medium">
                Invite created, but no email was sent to {undelivered.email}.
              </p>
              <p className="text-xs">
                Outbound email is not configured on this deployment. The invite is
                valid — send this link directly:
              </p>
              <code className="block text-[11px] font-mono break-all bg-white/70 rounded px-2 py-1">
                {undelivered.url}
              </code>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting || !email || perms.length === 0}>
              {submitting ? "Sending…" : "Send invite"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PermissionGrid({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const set = useMemo(() => new Set(value), [value]);
  function toggle(p: string) {
    const next = new Set(set);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange(Array.from(next).sort());
  }
  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const p of ALL_PERMISSIONS) {
      const ns = p.split(".")[0];
      const arr = g.get(ns) ?? [];
      arr.push(p);
      g.set(ns, arr);
    }
    return Array.from(g.entries());
  }, []);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {groups.map(([ns, ps]) => (
        <div key={ns} className="border border-slate-200 rounded p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">{ns}</p>
          <div className="space-y-1">
            {ps.map((p) => (
              <label key={p} className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={set.has(p)}
                  onChange={() => toggle(p)}
                  className="rounded"
                />
                <span className="font-mono">{p.slice(ns.length + 1)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
