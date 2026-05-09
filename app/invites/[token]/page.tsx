/**
 * /invites/[token] — public accept-invite landing page.
 *
 * No layout chrome (this is pre-auth). Renders the invite preview,
 * collects full name (+ password for new users), POSTs accept,
 * lands the user on /.
 */
"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Preview {
  orgName: string;
  email: string;
  roleTemplate: string;
  invitedByEmail: string | null;
  expiresAt: string;
  permissions: string[];
}

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/invites/${params.token}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Invite invalid.");
          return;
        }
        setPreview(d.data);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, [params.token]);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch(`/api/invites/${params.token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName, password: password || undefined }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!data.success) {
      if (res.status === 422 && /password/i.test(data.error)) {
        setNeedsPassword(true);
        setError("New account — please choose a password (min 12 chars).");
        return;
      }
      setError(data.error ?? "Accept failed.");
      return;
    }
    router.push(data.data.redirectTo ?? "/");
  }

  if (loading) {
    return <CenteredCard>Loading invite…</CenteredCard>;
  }

  if (!preview) {
    return (
      <CenteredCard>
        <h1 className="text-xl font-bold mb-2">Invite invalid</h1>
        <p className="text-sm text-slate-600">
          {error ?? "This invite has expired or already been redeemed."}
        </p>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <h1 className="font-display text-2xl tracking-tight">
        Join {preview.orgName} on Pallio
      </h1>
      <p className="text-sm text-slate-600 mt-1 mb-5">
        {preview.invitedByEmail ? `${preview.invitedByEmail} invited` : "You've been invited"}
        {" "}as a <strong>{preview.roleTemplate.replace("_", " ")}</strong>.
        You'll have {preview.permissions.length} permission
        {preview.permissions.length === 1 ? "" : "s"} on day one.
      </p>

      <form onSubmit={accept} className="space-y-4">
        <label className="block">
          <span className="block text-xs font-medium text-slate-700 mb-1">Email</span>
          <input
            value={preview.email}
            readOnly
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-slate-50 text-slate-600"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-slate-700 mb-1">Full name</span>
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
          />
        </label>
        {needsPassword && (
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">
              Password (min 12 chars)
            </span>
            <input
              required
              type="password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
            />
          </label>
        )}
        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
            {error}
          </div>
        )}
        <Button type="submit" disabled={submitting || !fullName} className="w-full">
          {submitting ? "Joining…" : "Accept invite"}
        </Button>
      </form>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-8">{children}</CardContent>
      </Card>
    </div>
  );
}
