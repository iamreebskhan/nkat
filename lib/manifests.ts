/**
 * Pallio sidebar role manifests.
 *
 * Source: pallio_ui_playbook §4.1 (manifest pattern).
 *
 * Each role has its own primary navigation, dashboard cards, and
 * default route. The sidebar renders from the active manifest.
 *
 * IMPORTANT: this is a DISPLAY concern only — see playbook §4.2 +
 * §14. Every API endpoint must independently verify the caller has
 * the required permission via `requireAuth([...])`. Never use the
 * UI manifest to gate server-side access.
 */
import type { Session } from "./auth";
import type { SerializableNavItem } from "@/components/sidebar";

/**
 * Icon names match keys in `components/sidebar.tsx`'s ICONS registry.
 * We pass strings (not components) across the Server→Client boundary
 * so React Server Components can serialize the manifest.
 */
export type NavIconName =
  | "AlertTriangle"
  | "BadgeCheck"
  | "BookOpen"
  | "Building2"
  | "Calendar"
  | "ClipboardList"
  | "FileStack"
  | "FileText"
  | "HeartPulse"
  | "Inbox"
  | "LineChart"
  | "Receipt"
  | "ScrollText"
  | "SearchCheck"
  | "Settings"
  | "ShieldCheck"
  | "Users";

export type NavItem = {
  label: string;
  href: string;
  icon: NavIconName;
  /** Optional notification count (queue depth, alerts). */
  badge?: number;
  /** Permission required to see this item — kept here for hint/UX. */
  requires?: string;
};

export type Manifest = {
  primary: NavItem[];
  /** Dashboard card slot keys — actual cards live in `components/cards/` */
  cards: string[];
  /** Where the role lands after login */
  defaultRoute: string;
};

export type RoleKey = Session["role"];

/**
 * The full set of role manifests. Org admins see the union of clinician
 * + billing_agent + admin items by default; consultants see whatever
 * the org explicitly grants. See vision §6.9 + §13.4 for rationale.
 */
export const MANIFESTS: Record<RoleKey, Manifest> = {
  clinician: {
    primary: [
      { label: "Visits today", href: "/visits", icon: "ClipboardList", requires: "visits.view.own" },
      { label: "My inbox", href: "/inbox", icon: "Inbox" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      { label: "Care plans", href: "/care-plans", icon: "HeartPulse", requires: "careplans.view" },
      { label: "Schedule", href: "/schedule", icon: "Calendar", requires: "schedule.view" },
    ],
    cards: ["visits_today", "inbox"],
    defaultRoute: "/visits",
  },
  billing_agent: {
    primary: [
      { label: "Claims queue", href: "/billing/claims", icon: "FileStack", requires: "visits.view.all" },
      { label: "Rule lookup", href: "/billing/lookup", icon: "SearchCheck", requires: "billing.lookup.view" },
      { label: "Superbills", href: "/billing/superbills", icon: "Receipt", requires: "billing.superbills.view" },
      { label: "Denials", href: "/billing/denials", icon: "AlertTriangle", requires: "billing.denials.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
      { label: "Cheat sheets", href: "/cheat-sheets", icon: "BookOpen", requires: "cheatsheets.view" },
    ],
    cards: ["denials_recent", "unbilled"],
    defaultRoute: "/billing/claims",
  },
  org_admin: {
    primary: [
      { label: "Dashboard", href: "/", icon: "LineChart" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      { label: "Schedule", href: "/schedule", icon: "Calendar", requires: "schedule.view" },
      { label: "Billing", href: "/billing/lookup", icon: "SearchCheck", requires: "billing.lookup.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
      { label: "Reports", href: "/reports", icon: "LineChart", requires: "reports.view" },
      { label: "Team", href: "/team", icon: "ShieldCheck", requires: "team.view" },
      { label: "Audit log", href: "/audit", icon: "FileText", requires: "audit.view" },
      { label: "Settings", href: "/settings", icon: "Settings", requires: "settings.view" },
    ],
    cards: ["kpis", "alerts", "recent_activity"],
    defaultRoute: "/",
  },
  platform_admin: {
    primary: [
      { label: "Organizations", href: "/admin/orgs", icon: "Building2" },
      { label: "Compliance", href: "/admin/compliance", icon: "BadgeCheck" },
      { label: "Platform health", href: "/admin/health", icon: "LineChart" },
      { label: "Ingestion sources", href: "/admin/ingestion-sources", icon: "FileStack" },
      { label: "Cheat sheet review", href: "/admin/cheatsheets", icon: "BookOpen" },
      { label: "Settings", href: "/admin/settings", icon: "Settings" },
    ],
    cards: ["compliance", "platform_kpis"],
    defaultRoute: "/admin/orgs",
  },
  consultant: {
    // Consultants have NO defaults by design — vision §13.4. The org
    // admin explicitly selects each permission for the engagement.
    // We compute the visible items at render time from session.permissions.
    primary: [
      { label: "Dashboard", href: "/", icon: "LineChart" },
      { label: "Rule lookup", href: "/billing/lookup", icon: "SearchCheck", requires: "billing.lookup.view" },
      { label: "Cheat sheets", href: "/cheat-sheets", icon: "BookOpen", requires: "cheatsheets.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
    ],
    cards: ["recent_activity"],
    defaultRoute: "/",
  },
  analyst: {
    primary: [
      { label: "Attestations", href: "/payers/attestations", icon: "FileText", requires: "knowledge.attest" },
      { label: "Documents", href: "/documents", icon: "FileStack", requires: "knowledge.upload" },
      { label: "Rule lookup", href: "/billing/lookup", icon: "SearchCheck", requires: "billing.lookup.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
    ],
    cards: ["attestation_queue", "expiring_attestations"],
    defaultRoute: "/payers/attestations",
  },
  read_only: {
    primary: [
      { label: "Dashboard", href: "/", icon: "LineChart" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      { label: "Visits", href: "/visits", icon: "ClipboardList", requires: "visits.view.all" },
      { label: "Reports", href: "/reports", icon: "LineChart", requires: "reports.view" },
    ],
    cards: ["recent_activity"],
    defaultRoute: "/",
  },
};

/**
 * Filter a manifest's primary items down to those the caller's
 * permission set actually allows. Items without a `requires` are
 * always visible. Items whose `requires` permission is missing get
 * dropped from the rendered sidebar.
 *
 * This is purely cosmetic — the server still re-checks permissions
 * on every fetch.
 */
export function visibleNavItems(
  manifest: Manifest,
  permissions: string[],
): NavItem[] {
  return manifest.primary.filter(
    (item) => !item.requires || permissions.includes(item.requires),
  );
}
