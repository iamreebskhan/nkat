/**
 * AmaLicenseBadge — visible status pill for the AMA CPT license.
 *
 * Source: pallio_complete_vision_v3 §15.1 (AMA license gating).
 *
 * When green ("Licensed"): full CPT short descriptors render.
 * When amber ("Redacted"): code list shows code + category only;
 * descriptors hidden until the operator wires AMA_LICENSE_TOKEN.
 *
 * Render in the sidebar footer (org_admin + billing_agent only).
 */
"use client";

import { useEffect, useState } from "react";

export function AmaLicenseBadge() {
  const [licensed, setLicensed] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/settings/license")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setLicensed(Boolean(d.data?.amaLicensed));
      })
      .catch(() => setLicensed(null));
  }, []);

  if (licensed === null) return null;

  return (
    <span
      title={
        licensed
          ? "AMA CPT license active — descriptors visible."
          : "AMA license not wired — CPT descriptors are redacted per §15.1."
      }
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium ring-1 ring-inset ${
        licensed
          ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
          : "bg-amber-50 text-amber-800 ring-amber-600/30"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${licensed ? "bg-emerald-500" : "bg-amber-500"}`}
        aria-hidden
      />
      AMA: {licensed ? "Licensed" : "Redacted"}
    </span>
  );
}
