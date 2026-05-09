/**
 * Root layout — wraps every route. Self-hosts fonts via Fontsource (no
 * Google CDN; HIPAA data-flow caution per pallio_ui_playbook §3.1).
 *
 * The fonts are imported in `globals.css` directly. We don't use
 * `next/font/google` because that proxies through Google in dev.
 */
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pallio",
  description:
    "Palliative-care EMR + billing intelligence. Document the visit, suggest the code, verify the rule, get paid.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
