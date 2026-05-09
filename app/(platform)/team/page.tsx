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
          fetch("/api/team/members").then((r) => r.json()),
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
          <p className="text-slate-600 mt-1">
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            {invites.length} pending invite{invites.length === 1 ? "" : "s"}
          </p>
        </div>
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

  function startEdit(r: MemberRow) {
    setEditing(r.userId);
    setPerms(r.permissions);
  }

  async function save(userId: string) {
    await fetch(`/api/team/members/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: perms }),
    });
    setEditing(null);
    onChange();
  }

  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-slate-500">No members yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">User</th>
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
                  <td className="px-4 py-2 text-right text-xs text-slate-600 tabular">
                    {m.permissions.length}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {editing === m.userId ? (
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => save(m.userId)}>
                          Save
                        </Button>
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
          <div className="px-4 py-4 border-t border-slate-200 bg-slate-50">
            <p className="text-xs font-medium mb-2 text-slate-700">Permissions</p>
            <PermissionGrid value={perms} onChange={setPerms} />
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
            <PermissionGrid value={perms} onChange={setPerms} />
          </div>
          {error && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting || !email}>
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
