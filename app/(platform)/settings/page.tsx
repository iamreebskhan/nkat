/**
 * /settings — top-level settings index. Links to sub-pages.
 */
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";

const SECTIONS = [
  { href: "/settings/account",  title: "Account",  desc: "Your name, password, email, role." },
  { href: "/settings/security", title: "Security", desc: "Two-step sign-in and recovery codes; for admins, sign-out after inactivity and who needs a second factor." },
  { href: "/settings/branding", title: "Branding", desc: "Logo, primary color, custom domain, email identity." },
  // The time zone sets every visit's date of service; the cap is what the
  // scheduler refuses past. Neither had a screen.
  { href: "/settings/practice", title: "Practice", desc: "Time zone, and how many visits a clinician can be booked for in a day." },
  { href: "/settings/billing",  title: "Billing",  desc: "Subscription tier, seats, invoice history." },
  // Who the claims bill as, and what the practice charges (0118; doc:67, :74).
  { href: "/settings/billing-provider", title: "Billing provider", desc: "Legal name, NPI, EIN, taxonomy and the billing and pay-to addresses your claims carry." },
  { href: "/settings/fees", title: "Fee schedule", desc: "The practice's own charge per code. Without one, a code bills at the payer's rate." },
  // CMS's files, loaded by the practice under its own licence (0122).
  { href: "/settings/ncci", title: "NCCI edits", desc: "CMS's code pairs and medically unlikely edits the claim review warns on, loaded from CMS's quarterly files." },
  // Was missing entirely — the page had zero inbound navigation paths.
  { href: "/settings/integrations", title: "Integrations", desc: "Clearinghouses (Availity, Waystar, TriZetto, Inovalon) for claims, eligibility and claim status; Google Calendar sync." },
  // Client walkthrough 02:30–02:36 — the org needs to extend both lists itself.
  { href: "/settings/visit-types", title: "Visit types", desc: "What appears in the visit-type dropdown when scheduling." },
  { href: "/settings/note-template", title: "Note template", desc: "The sections every visit note asks for, and which of them block signing." },
  { href: "/settings/visit-services", title: "Visit services", desc: "The services clinicians can record against a visit." },
  // The Trend Report's numbering, preloaded and editable (Mark Q11a default, 0111).
  { href: "/settings/reason-codes", title: "Reason codes", desc: "Why a patient was discharged, or a referral not taken under care, numbered as the monthly report counts them." },
  // Moved out of the primary nav into Settings (client walkthrough 05:29).
  { href: "/audit", title: "Audit log", desc: "Append-only record of every action. Rows under 6 years old cannot be deleted." },
  // Rulebook is now a top-level nav item ("Rulebook") — no duplicate door here.
];

export default function SettingsIndexPage() {
  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Settings</h1>
        <p className="text-slate-600 mt-1">Configure your organization.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="block">
            <Card className="hover:ring-2 hover:ring-[var(--color-brand-600)] transition">
              <CardContent className="p-5">
                <h2 className="font-display text-lg">{s.title}</h2>
                <p className="text-sm text-slate-600 mt-1">{s.desc}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
