/**
 * Render a stored note section to HTML.
 *
 * The note is TipTap/ProseMirror JSON, and nothing in the product could turn it
 * back into anything printable — four Puppeteer PDF builders ship under lib/
 * (superbill, patient record, cheat sheets) and none of them can render a note,
 * because this step did not exist. That is why "hand the auditor the note and
 * the superbill" was not buildable.
 *
 * Pure and dependency-free so it can be unit tested without a browser, and so
 * the PDF path and any future export share one renderer rather than drifting.
 *
 * Deliberately conservative: it renders the node types StarterKit can produce
 * and drops anything else rather than emitting unknown markup into a document
 * that goes to a payer. Everything is escaped — a note is clinician-entered
 * text and this HTML is handed to a browser.
 */

import { orgLocalMinute } from "@/lib/features/org/org-date";

import { VITALS_FIELDS } from "./vitals-units";

type Node = {
  type?: string;
  text?: string;
  content?: Node[];
  attrs?: Record<string, unknown>;
  marks?: { type?: string }[];
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render one section's stored content. `kind` decides how it is read. */
export function renderSectionHtml(
  kind: "prose" | "list" | "vitals",
  content: unknown,
): string {
  if (kind === "list") {
    const items = (content as { items?: unknown })?.items;
    if (!Array.isArray(items)) return "";
    const li = items
      .filter((i): i is string => typeof i === "string" && i.trim() !== "")
      .map((i) => `<li>${escapeHtml(i)}</li>`)
      .join("");
    return li ? `<ul>${li}</ul>` : "";
  }
  if (kind === "vitals") return ""; // rendered from visit_vitals, not from here
  return renderProse(content);
}

export function renderProse(doc: unknown): string {
  if (doc == null || typeof doc !== "object") return "";
  return renderNodes((doc as Node).content ?? []);
}

function renderNodes(nodes: Node[] | undefined): string {
  if (!Array.isArray(nodes)) return "";
  return nodes.map(renderNode).join("");
}

function renderNode(n: Node): string {
  if (!n || typeof n !== "object") return "";

  if (n.type === "text") {
    let out = escapeHtml(n.text ?? "");
    // Marks nest outward-in; order does not matter for these three.
    for (const m of n.marks ?? []) {
      if (m.type === "bold" || m.type === "strong") out = `<strong>${out}</strong>`;
      else if (m.type === "italic" || m.type === "em") out = `<em>${out}</em>`;
      else if (m.type === "code") out = `<code>${out}</code>`;
      else if (m.type === "strike") out = `<s>${out}</s>`;
    }
    return out;
  }

  switch (n.type) {
    case "paragraph": {
      const inner = renderNodes(n.content);
      // An empty paragraph is a deliberate blank line in a clinical note.
      return inner ? `<p>${inner}</p>` : "<p>&nbsp;</p>";
    }
    case "heading": {
      const raw = Number(n.attrs?.level ?? 2);
      const level = Number.isFinite(raw) ? Math.min(6, Math.max(1, raw)) : 2;
      return `<h${level}>${renderNodes(n.content)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${renderNodes(n.content)}</ul>`;
    case "orderedList": {
      const start = Number(n.attrs?.start ?? 1);
      const attr = Number.isFinite(start) && start !== 1 ? ` start="${Math.trunc(start)}"` : "";
      return `<ol${attr}>${renderNodes(n.content)}</ol>`;
    }
    case "listItem":
      return `<li>${renderNodes(n.content)}</li>`;
    case "blockquote":
      return `<blockquote>${renderNodes(n.content)}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${renderNodes(n.content)}</code></pre>`;
    case "horizontalRule":
      return "<hr />";
    case "hardBreak":
    case "hard_break":
      return "<br />";
    case "doc":
      return renderNodes(n.content);
    default:
      // Unknown node: render its children rather than dropping clinical text
      // that happens to sit inside a node type we do not recognise.
      return renderNodes(n.content);
  }
}

/** Plain text of a section, for anything that needs length or a preview. */
export function proseToText(doc: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null) return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (typeof n !== "object") return;
    const node = n as Node;
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (node.type === "paragraph" || node.type === "heading") parts.push("\n");
  };
  walk(doc);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Vitals as table rows, in the units the clinician entered them in.
 *
 * Driven by the same VITALS_FIELDS spec the capture grid and the trend screen
 * use, so a weight entered as 135.4 lb cannot come back as 61.4 kg in a
 * document handed to an auditor. Blood pressure is composed separately
 * because it is two stored columns shown as one reading.
 */
export function renderVitalsRows(v: Record<string, unknown> | null): string {
  if (!v) return "";
  const byKey = new Map(VITALS_FIELDS.map((f) => [f.key, f]));
  const show = (key: string, column: string): [string, string, string] | null => {
    const f = byKey.get(key);
    const raw = v[column];
    if (!f || raw === null || raw === undefined || raw === "") return null;
    return [f.label, String(f.fromStored(Number(raw))), f.unit ?? ""];
  };
  const s = v.bp_systolic;
  const dd = v.bp_diastolic;
  const pressure = s == null && dd == null ? null : `${s ?? "?"}/${dd ?? "?"}`;
  const rows: ([string, string, string] | null)[] = [
    show("weightKg", "weight_kg"),
    show("heightCm", "height_cm"),
    pressure ? ["Blood pressure", pressure, "mmHg"] : null,
    show("heartRate", "heart_rate"),
    show("respRate", "resp_rate"),
    show("temperatureC", "temperature_c"),
    show("spo2Percent", "spo2_percent"),
    show("ppsPercent", "pps_percent"),
    show("painScore", "pain_score"),
  ];
  return rows
    .filter((r): r is [string, string, string] => r !== null)
    .map(
      ([k, val, u]) =>
        `<tr><td class="k">${escapeHtml(k)}</td><td>${escapeHtml(val)} ${escapeHtml(u)}</td></tr>`,
    )
    .join("");
}

export interface RenderableSection {
  label: string;
  kind: "prose" | "list" | "vitals";
  content: unknown;
  is_empty: boolean;
  carried_unchanged: boolean;
}

/**
 * The signed note, section by section, as the audit packet prints it: every
 * section of the template, "Not documented" where empty, and a flag on text
 * carried forward unedited.
 */
export function renderNoteBodyHtml(sections: RenderableSection[], vitalsRows: string): string {
  return sections
    .map((s) => {
      const body =
        s.kind === "vitals"
          ? vitalsRows
            ? `<table>${vitalsRows}</table>`
            : `<p class="empty">Not recorded.</p>`
          : s.is_empty
            ? `<p class="empty">Not documented.</p>`
            : renderSectionHtml(s.kind, s.content) || `<p class="empty">Not documented.</p>`;
      const flag = s.carried_unchanged
        ? '<span class="flag">carried forward, unedited</span>'
        : "";
      return `<div class="sec"><h3>${escapeHtml(s.label)}${flag}</h3>${body}</div>`;
    })
    .join("");
}

/**
 * A note written before sections existed (visit.document_text): TipTap JSON,
 * or plain text from older imports. Never printed as raw JSON.
 */
export function renderLegacyNoteHtml(text: string | null | undefined): string {
  if (!text || !text.trim()) return "";
  try {
    const doc: unknown = JSON.parse(text);
    if (doc && typeof doc === "object") return renderProse(doc);
  } catch {
    /* plain text */
  }
  return `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`;
}

export interface RenderableAddendum {
  body: string;
  author_name: string | null;
  author_credential: string | null;
  signed_at: Date | string;
}

/**
 * Addenda after the signed note (audit R15), one renderer for the preview,
 * the audit packet and the patient record export. Signed times are on the
 * practice's clock (`timeZone`, org.timezone), like the date of visit above
 * them; they read as UTC.
 */
export function renderAddendaHtml(addenda: RenderableAddendum[], timeZone: string): string {
  if (addenda.length === 0) return "";
  const items = addenda
    .map((a) => {
      const who =
        escapeHtml(a.author_name ?? "Unknown author") +
        (a.author_credential ? `, ${escapeHtml(a.author_credential)}` : "");
      return `<div class="addendum"><h3>Addendum — ${who} · ${orgLocalMinute(a.signed_at, timeZone)}</h3><p style="white-space:pre-wrap">${escapeHtml(a.body)}</p></div>`;
    })
    .join("");
  return `<section class="addenda"><h2>Addenda</h2>${items}</section>`;
}

/**
 * Who attested the note, under which credential, and when (audit R32). Flags
 * a signer who is not the clinician of record by comparing user IDS — the
 * name comparison it replaces passed silently when names collided or were
 * missing.
 */
export function renderAttestationLine(a: {
  signerName: string | null;
  signerCredential: string | null;
  signedAt: Date | string | null;
  signedByUserId: string | null;
  clinicianUserId: string | null;
  /** org.timezone: the signed time is on the practice's clock, as the addenda's. */
  timeZone: string;
}): string {
  if (!a.signedAt) return `<p class="attestation">Not signed.</p>`;
  const who = escapeHtml(a.signerName ?? "an unknown user");
  const credential = a.signerCredential
    ? escapeHtml(a.signerCredential)
    : "credential not recorded";
  const flag =
    a.signedByUserId && a.clinicianUserId && a.signedByUserId !== a.clinicianUserId
      ? '<br /><span style="color:#b45309">The signer is not the clinician of record for this visit.</span>'
      : "";
  return `<p class="attestation">Electronically signed by <strong>${who}</strong>, ${credential} on ${orgLocalMinute(a.signedAt, a.timeZone)}.${flag}</p>`;
}

/** An outside provider linked to the patient, as the note header reads it. */
export interface HeaderProvider {
  role: string;
  role_label: string | null;
  full_name: string;
  npi: string | null;
  phone: string | null;
}

/** A family member or caregiver the note header may name. */
export interface HeaderContact {
  full_name: string;
  phone: string | null;
  is_healthcare_poa: boolean;
  is_primary_caregiver: boolean;
}

export interface HeaderRow {
  label: string;
  value: string;
}

/**
 * The care-team block of the note header (audit R30), in the order page 1 of
 * Mark's note uses: palliative care provider, primary care provider,
 * referring physician, then one line per specialist under its own label
 * (Pulmonologist, Oncologist), then any other provider. Primary care and
 * referring always print, as "—" when none is on file, because his header
 * always carries both. The healthcare POA and primary caregiver print only
 * when someone holds the role.
 *
 * Values read "Name (NPI n) · phone". Plain text: every caller escapes it, so
 * the preview and the audit packet print the same rows.
 */
export function careTeamHeaderRows(a: {
  palliativeProvider: string | null;
  providers: HeaderProvider[];
  contacts: HeaderContact[];
}): HeaderRow[] {
  const who = (name: string, npi: string | null, phone: string | null) =>
    [npi ? `${name} (NPI ${npi})` : name, phone].filter(Boolean).join(" · ");
  const ordered = (role: string) =>
    a.providers
      .filter((p) => p.role === role)
      .sort(
        (x, y) =>
          (x.role_label ?? "").localeCompare(y.role_label ?? "") || x.full_name.localeCompare(y.full_name),
      );
  const fixedRole = (role: string) => {
    const held = ordered(role);
    return held.length > 0 ? held.map((p) => who(p.full_name, p.npi, p.phone)).join("; ") : "—";
  };
  const labelled = (role: string, fallback: string) =>
    ordered(role).map((p) => ({
      label: p.role_label?.trim() || fallback,
      value: who(p.full_name, p.npi, p.phone),
    }));
  const byName = [...a.contacts].sort((x, y) => x.full_name.localeCompare(y.full_name));
  return [
    { label: "Palliative care provider", value: a.palliativeProvider?.trim() || "—" },
    { label: "Primary care provider", value: fixedRole("primary_care") },
    { label: "Referring physician", value: fixedRole("referring") },
    ...labelled("specialist", "Specialist"),
    ...labelled("other", "Other provider"),
    ...byName
      .filter((c) => c.is_healthcare_poa)
      .map((c) => ({ label: "Healthcare POA", value: who(c.full_name, null, c.phone) })),
    ...byName
      .filter((c) => c.is_primary_caregiver)
      .map((c) => ({ label: "Primary caregiver", value: who(c.full_name, null, c.phone) })),
  ];
}
