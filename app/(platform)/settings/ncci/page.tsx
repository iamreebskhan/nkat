/**
 * /settings/ncci — the NCCI edits the claim review warns on (0122): CMS's
 * practitioner procedure-to-procedure pairs and medically unlikely edits. The
 * practice downloads the files from CMS under its own acceptance of CMS's
 * licence and chooses them here. They are read in this browser; only the
 * pairs between codes Pallio knows, and the MUE values, are sent, and they
 * stay in this practice's account.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  NcciFileError,
  ptpParts,
  quarterFromName,
  quarterStart,
  readNcciFile,
  type MueRow,
  type NcciKind,
  type NcciTable,
  type PtpRow,
} from "@/lib/features/billing/ncci-files";
import type { NcciLoadView, NcciStatus } from "@/lib/features/billing/ncci-load.service";

const PTP_PAGE =
  "https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits";
const MUE_PAGE =
  "https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues";
/** Rows per request (ncci-load.service.ts takes up to 5,000). */
const BATCH = 4_000;

const n = (x: number) => x.toLocaleString("en-US");
const when = (iso: string) => new Date(iso).toLocaleString();

interface Chosen {
  tables: NcciTable[];
  /** Files that could not be read, each with why. */
  errors: string[];
}

type Note = { ok: boolean; text: string };

async function post(url: string, body: unknown): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ success: false, error: `The server answered ${r.status}.` }));
}

export default function NcciPage() {
  const [status, setStatus] = useState<NcciStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [inForceFrom, setInForceFrom] = useState("");
  const [licence, setLicence] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [inputKey, setInputKey] = useState(0);
  /** settings.view shows what is in use; only settings.org changes it. */
  const [canLoad, setCanLoad] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const perms: string[] = d.data?.permissions ?? [];
        setCanLoad(Boolean(d.success) && (perms.includes("settings.org") || d.data?.role === "platform_admin"));
      })
      .catch(() => {});
  }, []);

  const reload = useCallback(() => {
    fetch("/api/settings/ncci", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => (d.success ? setStatus(d.data as NcciStatus) : setFailed(d.error ?? "Could not load the NCCI edits.")))
      .catch(() => setFailed("Network error."));
  }, []);
  useEffect(() => reload(), [reload]);

  async function choose(files: FileList | null) {
    if (!files || files.length === 0 || !status) return;
    setNote(null);
    setChosen(null);
    const known = new Set(status.codes);
    const tables: NcciTable[] = [];
    const errors: string[] = [];
    for (const f of Array.from(files)) {
      setReading(f.name);
      // Let the page show which file is being read before the work starts.
      await new Promise((r) => setTimeout(r, 0));
      try {
        const found = await readNcciFile(f.name, new Uint8Array(await f.arrayBuffer()), known);
        if (found.length === 0) errors.push(`${f.name}: no NCCI table in it (no "Column 1 / Column 2" or "HCPCS/CPT Code / MUE Values" header).`);
        tables.push(...found);
      } catch (e) {
        errors.push(e instanceof NcciFileError ? e.message : `${f.name} could not be read.`);
      }
    }
    setReading(null);
    const mue = tables.find((t) => t.kind === "mue");
    setInForceFrom(mue ? (quarterFromName(mue.source) ?? quarterStart(status.today)) : "");
    setChosen({ tables, errors });
  }

  const ptpTables = chosen?.tables.filter((t) => t.kind === "ptp") ?? [];
  const mueTables = chosen?.tables.filter((t) => t.kind === "mue") ?? [];
  // The pairs once, however many files carried them.
  const ptpRows = [...new Map(ptpTables.flatMap((t) => t.ptp).map((r) => [`${r.column1}|${r.column2}|${r.effective}`, r])).values()];
  const mueRows = [...new Map(mueTables.flatMap((t) => t.mue).map((r) => [r.code, r])).values()];
  const parts = ptpParts(ptpTables.map((t) => t.source));
  const missingParts = parts.length > 0 ? [1, 2, 3, 4].filter((p) => !parts.includes(p)) : [];
  const blocked =
    mueTables.length > 1
      ? "Choose one MUE table at a time: each applies from its own date."
      : mueRows.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(inForceFrom)
        ? "From which date of service do these MUE values apply?"
        : null;

  async function send(kind: NcciKind, rows: (PtpRow | MueRow)[], tables: NcciTable[]): Promise<string> {
    const start = await post("/api/settings/ncci/loads", {
      kind,
      files: tables.map((t) => t.source).slice(0, 40),
      ...(kind === "mue" ? { inForceFrom } : {}),
      licenceAccepted: licence,
    });
    if (!start.success) throw new Error(start.error ?? "The load could not be started.");
    const id = (start.data as { id: string }).id;
    for (let i = 0; i < rows.length; i += BATCH) {
      setSending(`Sending ${kind === "ptp" ? "pairs" : "MUE values"}: ${n(Math.min(i + BATCH, rows.length))} of ${n(rows.length)}…`);
      const r = await post(`/api/settings/ncci/loads/${id}/rows`, { [kind]: rows.slice(i, i + BATCH) });
      if (!r.success) throw new Error(r.error ?? "A batch was refused.");
    }
    const done = await post(`/api/settings/ncci/loads/${id}/commit`, { rowsRead: tables.reduce((s, t) => s + t.rowsRead, 0) });
    if (!done.success) throw new Error(done.error ?? "The load could not be put in use.");
    const v = done.data as NcciLoadView;
    return kind === "ptp" ? `${n(v.rowsKept)} pairs` : `${n(v.rowsKept)} MUE values for dates of service from ${v.inForceFrom}`;
  }

  async function load() {
    if (!chosen || blocked) return;
    setNote(null);
    const done: string[] = [];
    try {
      if (ptpRows.length > 0) done.push(await send("ptp", ptpRows, ptpTables));
      else if (ptpTables.length > 0) throw new Error("None of the pairs in these PTP files are between codes Pallio knows, so there is nothing to load from them.");
      if (mueRows.length > 0) done.push(await send("mue", mueRows, mueTables));
      setNote({ ok: true, text: `Loaded ${done.join(" and ")}. The claim review checks against them from now on.` });
      setChosen(null);
      setLicence(false);
      setInputKey((k) => k + 1);
    } catch (e) {
      const loaded = done.length > 0 ? ` (${done.join(" and ")} were loaded first)` : "";
      setNote({ ok: false, text: `${e instanceof Error ? e.message : "Not loaded."}${loaded}` });
    } finally {
      setSending(null);
      reload();
    }
  }

  async function stop(l: NcciLoadView) {
    const what = l.kind === "ptp" ? "the NCCI pairs" : `the MUE values in force from ${l.inForceFrom}`;
    if (!window.confirm(`Stop using ${what}? Claims are no longer checked against them until files are loaded again.`)) return;
    const r = await fetch(`/api/settings/ncci/loads/${l.id}`, { method: "DELETE" }).then((x) => x.json()).catch(() => null);
    setNote(r?.success ? { ok: true, text: `No longer using ${what}.` } : { ok: false, text: r?.error ?? "Not changed." });
    reload();
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">NCCI edits</h1>
        <p className="text-slate-600 mt-1">
          When a claim is marked ready, Pallio warns if it bills two codes CMS&rsquo;s National Correct Coding Initiative pairs
          (a procedure-to-procedure edit), or more units of a code than its medically unlikely edit (MUE) allows. CMS
          publishes both every quarter. Your practice downloads them from CMS, accepting CMS&rsquo;s licence, and loads them
          here; they stay in your practice&rsquo;s account.
        </p>
      </header>
      {failed && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {failed}
        </p>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={`mb-4 rounded px-3 py-2 text-sm ${note.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"}`}>
          {note.text}
        </p>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>In use</CardTitle>
          <CardDescription>What the claim review checks against now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {!status ? (
            <p className="text-slate-500">Loading…</p>
          ) : (
            <>
              <section aria-label="Procedure-to-procedure pairs">
                <h3 className="font-medium text-slate-800">Procedure-to-procedure pairs</h3>
                {status.ptp ? (
                  <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
                    <p className="text-slate-700">
                      {n(status.ptp.rowsKept)} pairs between the {n(status.ptp.codesCovered ?? 0)} codes Pallio knew, read from{" "}
                      {n(status.ptp.rowsRead)} rows in {status.ptp.files.length} file{status.ptp.files.length === 1 ? "" : "s"}. Loaded{" "}
                      {when(status.ptp.loadedAt)}
                      {status.ptp.loadedByName && ` by ${status.ptp.loadedByName}`}.
                    </p>
                    {canLoad && (
                      <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => void stop(status.ptp!)}>
                        Stop using
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-slate-500">Not loaded: claims are not checked for NCCI pairs.</p>
                )}
                {status.ptp && status.uncovered.length > 0 && (
                  <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                    {n(status.uncovered.length)} code{status.uncovered.length === 1 ? "" : "s"} Pallio knows now came after this load
                    ({status.uncovered.slice(0, 12).join(", ")}
                    {status.uncovered.length > 12 ? ", …" : ""}): pairs with {status.uncovered.length === 1 ? "it are" : "them are"} not checked
                    until the PTP files are loaded again.
                  </p>
                )}
              </section>
              <section aria-label="MUE values">
                <h3 className="font-medium text-slate-800">Medically unlikely edits</h3>
                {status.mue.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {status.mue.map((l, i) => (
                      <li key={l.id} className="flex flex-wrap items-start justify-between gap-2">
                        <span className="text-slate-700">
                          {n(l.rowsKept)} codes, for dates of service from {l.inForceFrom}
                          {i > 0 && ` until ${status.mue[i - 1]!.inForceFrom}`}. Loaded {when(l.loadedAt)}
                          {l.loadedByName && ` by ${l.loadedByName}`}.
                        </span>
                        {canLoad && (
                          <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => void stop(l)}>
                            Stop using
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-slate-500">Not loaded: claims are not checked for units above an MUE.</p>
                )}
              </section>
            </>
          )}
        </CardContent>
      </Card>

      {canLoad && (
        <Card>
          <CardHeader>
            <CardTitle>Load CMS&rsquo;s files</CardTitle>
            <CardDescription>Each quarter, when CMS publishes new ones.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-slate-700">
              <li>
                From CMS&rsquo;s{" "}
                <a href={PTP_PAGE} target="_blank" rel="noreferrer" className="underline">
                  PTP edits page
                </a>
                , the quarter&rsquo;s four <strong>Practitioner PTP Edits</strong> files (&hellip;ccipra&hellip;-f1 to -f4). CMS asks
                you to accept its licence for each.
              </li>
              <li>
                From CMS&rsquo;s{" "}
                <a href={MUE_PAGE} target="_blank" rel="noreferrer" className="underline">
                  MUE page
                </a>
                , the <strong>Practitioner Services MUE Table</strong>.
              </li>
              <li>Choose them below as they downloaded (ZIP), all at once. Not the hospital or DME files, and not the quarterly lists of changes.</li>
            </ol>
            <p className="text-xs text-slate-500">
              The files are read in this browser. Only the pairs between the {status ? n(status.codes.length) : "…"} codes Pallio
              knows for your practice (its catalog, payer rules, fees and every code on your visits and claims) and the MUE
              values are sent. A load of PTP files takes the place of the pairs loaded before, so choose all four together.
            </p>
            <input
              key={inputKey}
              type="file"
              multiple
              accept=".zip,.txt,.csv,.xlsx"
              aria-label="CMS NCCI files"
              disabled={!status || reading !== null || sending !== null}
              onChange={(e) => void choose(e.target.files)}
              className="block w-full text-sm"
            />
            {reading && <p role="status" className="text-slate-600">Reading {reading}…</p>}

            {chosen && (
              <div className="space-y-3">
                {chosen.errors.map((e) => (
                  <p key={e} role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
                    {e}
                  </p>
                ))}
                {chosen.tables.length > 0 && (
                  <ul className="divide-y divide-slate-100 rounded border border-slate-200" aria-label="Files read">
                    {chosen.tables.map((t) => (
                      <li key={t.source} className="px-3 py-2">
                        <div className="font-medium text-slate-800">{t.source}</div>
                        <div className="text-xs text-slate-600">
                          {t.kind === "ptp"
                            ? `PTP pairs: ${n(t.rowsRead)} rows read, ${n(t.ptp.length)} kept (both codes known), ${n(t.notKept)} passed over`
                            : `MUE values: ${n(t.rowsRead)} rows read, ${n(t.mue.length)} kept`}
                          {t.unreadable > 0 && `, ${n(t.unreadable)} not readable`}.
                        </div>
                        {t.problems.length > 0 && (
                          <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
                            {t.problems.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {missingParts.length > 0 && (
                  <p role="alert" className="rounded bg-amber-50 px-3 py-2 text-amber-900">
                    CMS publishes the practitioner pairs in four parts; part{missingParts.length === 1 ? "" : "s"} {missingParts.join(", ")}{" "}
                    {missingParts.length === 1 ? "was" : "were"} not chosen. The pairs in {missingParts.length === 1 ? "it" : "them"} would
                    not be checked, and this load replaces the pairs loaded before.
                  </p>
                )}
                {mueRows.length > 0 && (
                  <label className="block">
                    <span className="block text-xs font-medium text-slate-700 mb-1">The MUE values apply to dates of service from</span>
                    <input
                      type="date"
                      value={inForceFrom}
                      onChange={(e) => setInForceFrom(e.target.value)}
                      className="h-9 rounded-md border border-slate-300 px-2 text-sm"
                    />
                    <span className="block text-xs text-slate-500 mt-1">The first day of the quarter the table is for.</span>
                  </label>
                )}
                {(ptpRows.length > 0 || mueRows.length > 0) && (
                  <>
                    <label className="flex items-start gap-2 text-slate-700">
                      <input type="checkbox" className="mt-1" checked={licence} onChange={(e) => setLicence(e.target.checked)} />
                      <span>
                        These files were downloaded from CMS by our practice, which accepted CMS&rsquo;s licence for them, and are for
                        our own use.
                      </span>
                    </label>
                    {blocked && (
                      <p role="alert" className="text-red-700">
                        {blocked}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" onClick={() => void load()} disabled={!licence || blocked !== null || sending !== null} loading={sending !== null}>
                        Load{" "}
                        {[ptpRows.length > 0 && `${n(ptpRows.length)} pairs`, mueRows.length > 0 && `${n(mueRows.length)} MUE values`]
                          .filter(Boolean)
                          .join(" and ")}
                      </Button>
                      {sending && <span role="status" className="text-slate-600">{sending}</span>}
                    </div>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
