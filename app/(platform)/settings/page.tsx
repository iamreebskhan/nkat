/**
 * /settings — top-level settings index. Links to sub-pages.
 */
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";

const SECTIONS = [
  { href: "/settings/branding", title: "Branding", desc: "Logo, primary color, custom domain, email identity." },
  { href: "/settings/billing",  title: "Billing",  desc: "Subscription tier, seats, invoice history." },
  { href: "/settings/rulebook", title: "Rulebook", desc: "Org's source of truth for payer rules." },
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
