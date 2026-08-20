import type { NextConfig } from "next";

/**
 * Security response headers.
 *
 * A live browser audit of app.pallio.io found NONE of these present. The one
 * that matters most for this product is frame-ancestors: without it any site
 * can put Pallio in an invisible iframe over its own buttons and collect the
 * clicks of a signed-in clinician — on an app whose pages discharge patients,
 * change coverage answers and submit superbills. Everything else here is the
 * cheap standard set that was simply never added.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   Strict-Transport-Security. The edge already sends max-age=31536000 and
 *   setting it here too would emit the header twice. It belongs in one place,
 *   and that place is already doing it.
 *
 *   A full CSP (script-src/style-src). Next.js serves inline hydration script
 *   and inline style; a strict policy needs per-request nonces wired through
 *   the document, and a wrong one white-screens the app. That is a change to
 *   make deliberately and verify, not to slip in alongside a header list.
 *   frame-ancestors is carried below because it is the half that stops
 *   clickjacking and cannot break script or style loading.
 */
const securityHeaders = [
  // Clickjacking. frame-ancestors is the modern control; X-Frame-Options is
  // kept for browsers that predate it. Pallio is never framed by anyone.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // Stop a browser from re-guessing a Content-Type we set deliberately — the
  // app serves user-supplied PDFs and CSVs, which is exactly where sniffing
  // turns an upload into script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Patient identifiers live in paths like /patients/<id>. This keeps the path
  // out of the Referer on any cross-origin navigation — which happens every
  // time a biller clicks through to a payer's policy document.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here needs a camera, a microphone or a location.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // Stops advertising the framework on every response.
  poweredByHeader: false,
  // pdf.js is loaded at runtime by the ingestion PHI screen and must be
  // required from node_modules, not bundled: it ships its own worker and
  // resolves font/cmap assets by path, both of which the bundler rewrites.
  serverExternalPackages: ["pdfjs-dist"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
