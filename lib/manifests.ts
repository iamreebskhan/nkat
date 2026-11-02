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
  | "BarChart3"
  | "BookOpen"
  | "Building2"
  | "Calendar"
  | "ClipboardList"
  | "FileStack"
  | "FileText"
  | "HeartPulse"
  | "Inbox"
  | "LineChart"
  | "ListChecks"
  | "Receipt"
  | "ScrollText"
  | "SearchCheck"
  | "Send"
  | "Settings"
  | "ShieldCheck"
  | "Stethoscope"
  | "UserPlus"
  | "Users"
  | "WifiOff";

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
      // Between visits (0116, Level-1 doc:48, :54): the patients I care for,
      // and the team's tasks.
      { label: "My caseload", href: "/caseload", icon: "Stethoscope", requires: "patients.view" },
      // The caseload saved to the device for a home with no signal (0119, doc:33).
      { label: "Offline copy", href: "/offline", icon: "WifiOff", requires: "patients.view" },
      { label: "Tasks", href: "/tasks", icon: "ListChecks" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      // Triage is a nurse's (Level-1 doc:26), so the clinical team reads the
      // board: patients.edit is what recording triage takes.
      { label: "Referrals", href: "/referrals", icon: "UserPlus", requires: "patients.edit" },
      { label: "Care plans", href: "/care-plans", icon: "HeartPulse", requires: "careplans.view" },
      { label: "Schedule", href: "/schedule", icon: "Calendar", requires: "schedule.view" },
      // Hidden unless granted (audit R38): ticking these used to give a
      // member no screen to use them on.
      { label: "Attestations", href: "/payers/attestations", icon: "FileText", requires: "knowledge.attest" },
      { label: "KPI report", href: "/reports", icon: "BarChart3", requires: "reports.view" },
      { label: "Audit log", href: "/audit", icon: "ShieldCheck", requires: "audit.view" },
    ],
    cards: ["visits_today", "inbox"],
    defaultRoute: "/visits",
  },
  intake_coordinator: {
    // Referrals in, charts opened, visits booked (Level-1 audit, 27 Oct). The
    // board is where the day starts: intake "does all the referrals" [M 00:38].
    primary: [
      { label: "Referrals", href: "/referrals", icon: "UserPlus", requires: "patients.create" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      { label: "Schedule", href: "/schedule", icon: "Calendar", requires: "schedule.view" },
      // Administrative tasks reach intake too (doc:40).
      { label: "Tasks", href: "/tasks", icon: "ListChecks" },
      { label: "Audit log", href: "/audit", icon: "ShieldCheck", requires: "audit.view" },
    ],
    cards: [],
    defaultRoute: "/referrals",
  },
  billing_agent: {
    primary: [
      { label: "Billing", href: "/billing", icon: "Receipt", requires: "billing.superbills.view" },
      { label: "Claims queue", href: "/billing/claims", icon: "FileStack", requires: "visits.view.all" },
      { label: "Rule lookup", href: "/billing/lookup", icon: "SearchCheck", requires: "billing.lookup.view" },
      { label: "Superbills", href: "/billing/superbills", icon: "Receipt", requires: "billing.superbills.view" },
      { label: "Denials", href: "/billing/denials", icon: "AlertTriangle", requires: "billing.denials.view" },
      // The files claims went out in and what came back (0120).
      { label: "Clearinghouse", href: "/billing/clearinghouse", icon: "Send", requires: "billing.superbills.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
      { label: "Cheat sheets", href: "/cheat-sheets", icon: "BookOpen", requires: "cheatsheets.view" },
      { label: "Attestations", href: "/payers/attestations", icon: "FileText", requires: "knowledge.attest" },
      // An administrative task can be the billing team's (doc:40).
      { label: "Tasks", href: "/tasks", icon: "ListChecks" },
      { label: "KPI report", href: "/reports", icon: "BarChart3", requires: "reports.view" },
      { label: "Audit log", href: "/audit", icon: "ShieldCheck", requires: "audit.view" },
    ],
    cards: ["denials_recent", "unbilled"],
    defaultRoute: "/billing/claims",
  },
  org_admin: {
    primary: [
      { label: "Dashboard", href: "/", icon: "LineChart" },
      // The KPI report (Level-1 doc:80-109). Reports was withdrawn because it
      // duplicated the Dashboard (client walkthrough 04:51 — "Reports aur
      // Dashboard same hain, filhaal remove kar do"); the page is now the
      // monthly KPI table, which the Dashboard is not.
      { label: "KPI report", href: "/reports", icon: "BarChart3", requires: "reports.view" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      { label: "Referrals", href: "/referrals", icon: "UserPlus", requires: "patients.create" },
      { label: "Schedule", href: "/schedule", icon: "Calendar", requires: "schedule.view" },
      // Between visits (0116): an admin is often on a care team, and gives tasks.
      { label: "My caseload", href: "/caseload", icon: "Stethoscope", requires: "patients.view" },
      { label: "Offline copy", href: "/offline", icon: "WifiOff", requires: "patients.view" },
      { label: "Tasks", href: "/tasks", icon: "ListChecks" },
      // Billing lands on the dashboard (records + Create bill), not the
      // research tool — walkthrough 03:23.
      { label: "Billing", href: "/billing", icon: "Receipt", requires: "billing.superbills.view" },
      // Was billing_agent-only, so an org_admin who signed a visit had no
      // navigable way to watch it land (walkthrough 03:18).
      { label: "Claims queue", href: "/billing/claims", icon: "FileStack", requires: "visits.view.all" },
      { label: "Clearinghouse", href: "/billing/clearinghouse", icon: "Send", requires: "billing.superbills.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
      { label: "Team", href: "/team", icon: "ShieldCheck", requires: "team.view" },
      // Audit log moved under Settings (walkthrough 05:29).
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
      // The payer roster (audit R17). Before this only a seed and a deploy
      // could add a plan or withdraw one.
      { label: "Payers", href: "/admin/payers", icon: "Building2" },
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
      { label: "KPI report", href: "/reports", icon: "BarChart3", requires: "reports.view" },
      { label: "Rule lookup", href: "/billing/lookup", icon: "SearchCheck", requires: "billing.lookup.view" },
      { label: "Cheat sheets", href: "/cheat-sheets", icon: "BookOpen", requires: "cheatsheets.view" },
      { label: "Rulebook", href: "/settings/rulebook", icon: "ScrollText", requires: "knowledge.view" },
      { label: "Attestations", href: "/payers/attestations", icon: "FileText", requires: "knowledge.attest" },
      { label: "Audit log", href: "/audit", icon: "ShieldCheck", requires: "audit.view" },
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
      { label: "Audit log", href: "/audit", icon: "ShieldCheck", requires: "audit.view" },
    ],
    cards: ["attestation_queue", "expiring_attestations"],
    defaultRoute: "/payers/attestations",
  },
  read_only: {
    primary: [
      { label: "Dashboard", href: "/", icon: "LineChart" },
      { label: "KPI report", href: "/reports", icon: "BarChart3", requires: "reports.view" },
      { label: "Patients", href: "/patients", icon: "Users", requires: "patients.list" },
      { label: "Visits", href: "/visits", icon: "ClipboardList", requires: "visits.view.all" },
      { label: "Audit log", href: "/audit", icon: "ShieldCheck", requires: "audit.view" },
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
