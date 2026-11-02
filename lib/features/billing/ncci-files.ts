/**
 * CMS's NCCI files, read in the browser (0122). The practice downloads them
 * from CMS under its own acceptance of the licence and chooses them on
 * Settings → NCCI edits; only the rows kept are sent to Pallio.
 *
 * What CMS publishes each quarter:
 *   PTP  practitioner procedure-to-procedure edits, in four ZIPs, each holding
 *        a tab-delimited TXT (and an XLSX of the same rows): lines of notice,
 *        then the header — Column 1, Column 2, "*=in existence prior to 1996",
 *        Effective Date, "Deletion Date *=no data", "Modifier 0=not allowed
 *        1=allowed 9=not applicable", PTP Edit Rationale — then one pair a
 *        line, dates as YYYYMMDD and "*" for no deletion date.
 *   MUE  the practitioner services table, one ZIP: HCPCS/CPT Code,
 *        Practitioner Services MUE Values, MUE Adjudication Indicator ("2 Date
 *        of Service Edit: Policy"), MUE Rationale. No dates: the file is the
 *        quarter's.
 *
 * Columns are found by the header's words, not their position, and dates are
 * read in each form a spreadsheet may turn them into, so a file re-saved from
 * Excel reads the same. Pure; runs in the browser and in Node.
 */

export type NcciKind = "ptp" | "mue";

export interface PtpRow {
  column1: string;
  column2: string;
  /** 0: never billed together; 1: with an NCCI-associated modifier. (9 is not an edit and is not kept.) */
  modifierIndicator: 0 | 1;
  /** YYYY-MM-DD */
  effective: string;
  /** The first date of service the pair no longer applies to, YYYY-MM-DD; null while it does. */
  deletion: string | null;
  rationale: string | null;
}

export interface MueRow {
  code: string;
  unitsMax: number;
  /** 1 per line; 2 per day, policy; 3 per day, clinical. */
  adjudication: 1 | 2 | 3 | null;
  rationale: string | null;
}

/** One table read from a file: what it is, what was kept, and what was not. */
export interface NcciTable {
  /** The file, or "archive.zip › entry.txt". */
  source: string;
  kind: NcciKind;
  /** Data rows under the header. */
  rowsRead: number;
  ptp: PtpRow[];
  mue: MueRow[];
  /** Pairs not kept: a code Pallio does not know, modifier indicator 9, or deleted the day it began. */
  notKept: number;
  /** Rows whose codes, dates or values could not be read; the first few say why. */
  unreadable: number;
  problems: string[];
  /** MUE only: whose table it is, from its value column ("Practitioner Services MUE Values"). */
  setting?: "practitioner" | "other";
}

/** A file that cannot be read at all, said so the person can act on it. */
export class NcciFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NcciFileError";
  }
}

export const NCCI_CODE = /^[A-Z0-9]{5}$/;

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

export const isZip = (b: Uint8Array) => b.length >= 4 && u32(b, 0) === 0x04034b50;

async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every file in a ZIP (folders left out), stored or deflated. */
export async function unzip(bytes: Uint8Array, label = "The ZIP file"): Promise<ZipEntry[]> {
  const damaged = `${label} is damaged or incomplete. Download it again from CMS.`;
  // The end-of-directory record: 22 bytes, then a comment of up to 64 KB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new NcciFileError(damaged);
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) {
    throw new NcciFileError(`${label} is a ZIP64 archive, which Pallio does not read. Unzip it and choose the .txt file inside.`);
  }
  const names = new TextDecoder("utf-8");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) throw new NcciFileError(damaged);
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const size = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const local = u32(bytes, p + 42);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new NcciFileError(`${name} in ${label} is password-protected. Use the file as CMS publishes it.`);
    if (size === 0xffffffff || local === 0xffffffff) {
      throw new NcciFileError(`${label} is a ZIP64 archive, which Pallio does not read. Unzip it and choose the .txt file inside.`);
    }
    if (u32(bytes, local) !== 0x04034b50) throw new NcciFileError(damaged);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + size);
    if (raw.length !== size) throw new NcciFileError(damaged);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
    else throw new NcciFileError(`${name} in ${label} is compressed in a way Pallio does not read. Unzip it and choose the file inside.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text: TXT (tab-delimited) and CSV
// ---------------------------------------------------------------------------

/** UTF-8 when the bytes are, else Windows-1252 (what a TXT saved on Windows is). */
export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

const unquote = (c: string) => {
  const t = c.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"').trim() : t;
};

/**
 * Each line of a text table as cells. Tab-delimited when the opening lines
 * hold a tab (CMS's TXT), split by indexOf so a file of a million lines stays
 * quick; otherwise CSV, quotes and line breaks inside quotes kept.
 */
export function* textRows(text: string): Generator<string[]> {
  if (text.slice(0, 20_000).includes("\t")) {
    let i = 0;
    while (i < text.length) {
      let j = text.indexOf("\n", i);
      if (j < 0) j = text.length;
      const line = text.charCodeAt(j - 1) === 13 ? text.slice(i, j - 1) : text.slice(i, j);
      i = j + 1;
      yield line.split("\t").map(unquote);
    }
    return;
  }
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    any = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      yield row;
      row = [];
      cell = "";
      any = false;
    } else if (ch !== "\r") cell += ch;
  }
  if (any) {
    row.push(cell.trim());
    yield row;
  }
}

// ---------------------------------------------------------------------------
// XLSX: the first worksheet, as text cells
// ---------------------------------------------------------------------------

const XML_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : (XML_ENTITY[e.toLowerCase()] ?? _),
  );

/** "B" → 1, "AA" → 26. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The text of every <t> in a block (a shared string's runs, or an inline string). */
const runsText = (block: string) => [...block.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join("");

/** The first worksheet of an XLSX (already unzipped), row by row. */
export function* xlsxRows(entries: ZipEntry[], label = "The workbook"): Generator<string[]> {
  const files = new Map(entries.map((e) => [e.name.replace(/^\//, ""), e.data]));
  const text = (path: string) => {
    const d = files.get(path);
    return d ? new TextDecoder("utf-8").decode(d) : null;
  };
  // The first sheet the workbook lists, through its relationship; else the
  // first worksheet file there is.
  let sheetPath: string | null = null;
  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const rid = workbook?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  if (rid && rels) {
    const target = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
      .map((m) => m[0])
      .find((r) => r.includes(`Id="${rid}"`))
      ?.match(/Target="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  if (!sheetPath || !files.has(sheetPath)) {
    sheetPath = [...files.keys()].filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort()[0] ?? null;
  }
  const sheet = sheetPath ? text(sheetPath) : null;
  if (!sheet) throw new NcciFileError(`${label} has no worksheet Pallio can read.`);
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1]!));

  for (const r of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const at = ref ? columnIndex(ref) : next;
      next = at + 1;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const body = c[2] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
      else if (type === "inlineStr") value = runsText(body);
      else if (v !== undefined) value = xmlText(v);
      while (cells.length < at) cells.push("");
      cells[at] = value.trim();
    }
    yield cells;
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function isoDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d || y < 1980 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A date as CMS writes it (YYYYMMDD) or as a spreadsheet re-saves it
 * (MM/DD/YYYY, YYYY-MM-DD, or an Excel day number). null when it is none of
 * these.
 */
export function ncciDate(cell: string | undefined): string | null {
  const s = (cell ?? "").trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\.0+)?$/))) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return isoDate(+m[3]!, +m[1]!, +m[2]!);
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/))) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  if (/^\d{5}(?:\.0+)?$/.test(s)) {
    // Excel's day number (1900 system: day 1 is 1 Jan 1900, with its phantom
    // 29 Feb 1900, so later days count from 30 Dec 1899).
    const t = new Date(Date.UTC(1899, 11, 30) + Math.trunc(Number(s)) * 86_400_000);
    return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  return null;
}

/** "*", "", "N/A": no deletion date. */
const noDate = (cell: string | undefined) => /^(\*|n\/?a|none|-)?$/i.test((cell ?? "").trim());

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface PtpColumns {
  c1: number;
  c2: number;
  effective: number;
  deletion: number;
  modifier: number;
  rationale: number;
}
interface MueColumns {
  code: number;
  value: number;
  mai: number;
  rationale: number;
  setting: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function ptpColumns(labels: string[]): PtpColumns | null {
  const at = (re: RegExp) => labels.findIndex((l) => re.test(l));
  const c = {
    c1: at(/^column ?(1|one)\b/),
    c2: at(/^column ?(2|two)\b/),
    effective: at(/effective/),
    deletion: at(/delet/),
    modifier: at(/modifier/),
    rationale: at(/rationale/),
  };
  return c.c1 >= 0 && c.c2 >= 0 && c.effective >= 0 && c.modifier >= 0 ? c : null;
}

function mueColumns(labels: string[]): MueColumns | null {
  const at = (re: RegExp, not?: RegExp) => labels.findIndex((l) => re.test(l) && !(not && not.test(l)));
  const value = at(/\bmue\b.*\bvalues?\b|\bvalues?\b.*\bmue\b/, /adjudication|rationale/);
  const c = {
    code: at(/hcpcs|\bcpt\b/, /\bmue\b/),
    value,
    mai: at(/adjudication|\bmai\b/),
    rationale: at(/rationale/),
    setting: value >= 0 ? labels[value]! : "",
  };
  return c.code >= 0 && c.value >= 0 ? c : null;
}

type Header =
  | { kind: "ptp"; dataFrom: number; cols: PtpColumns }
  | { kind: "mue"; dataFrom: number; cols: MueColumns };

function headerOf(labels: string[], dataFrom: number): Header | null {
  const p = ptpColumns(labels);
  if (p) return { kind: "ptp", dataFrom, cols: p };
  const m = mueColumns(labels);
  return m ? { kind: "mue", dataFrom, cols: m } : null;
}

/** Whether a row under a header is data: its code column holds a code. */
const isData = (h: Header, row: string[]) =>
  NCCI_CODE.test((row[h.kind === "ptp" ? h.cols.c1 : h.cols.code] ?? "").trim().toUpperCase());

/**
 * The header among the first rows: on one row, or split over two (a label's
 * second line under it), in which case the second row is not data.
 */
function findHeader(head: string[][]): Header | null {
  for (let i = 0; i < head.length; i++) {
    const row = head[i]!;
    const next = head[i + 1];
    const merged = next
      ? Array.from({ length: Math.max(row.length, next.length) }, (_, k) => norm(`${row[k] ?? ""} ${next[k] ?? ""}`))
      : null;
    const one = headerOf(row.map(norm), i + 1);
    if (one) {
      const two = next && !isData(one, next) && next.some((c) => c.trim() !== "") && merged ? headerOf(merged, i + 2) : null;
      return two ?? one;
    }
    const two = merged ? headerOf(merged, i + 2) : null;
    if (two) return two;
  }
  return null;
}

const NOTED_PROBLEMS = 5;
/** The header comes after a few lines of notice; this is far more than CMS uses. */
const HEADER_WITHIN = 60;

/**
 * Read one table. `known` is the codes Pallio knows: a PTP pair is kept only
 * when both of its codes are in it (the whole table runs to millions of rows).
 * Every MUE row is kept. Returns null when the rows hold no NCCI header.
 */
export function readNcciTable(rows: Iterable<string[]>, source: string, known: ReadonlySet<string>): NcciTable | null {
  const it = rows[Symbol.iterator]();
  const head: string[][] = [];
  for (let r = it.next(); !r.done; r = it.next()) {
    head.push(r.value);
    if (head.length >= HEADER_WITHIN) break;
  }
  const header = findHeader(head);
  if (!header) return null;

  const t: NcciTable = { source, kind: header.kind, rowsRead: 0, ptp: [], mue: [], notKept: 0, unreadable: 0, problems: [] };
  if (header.kind === "mue") t.setting = /hospital|outpatient|dme|supplier/.test(header.cols.setting) ? "other" : "practitioner";
  const problem = (line: number, why: string) => {
    t.unreadable++;
    if (t.problems.length < NOTED_PROBLEMS) t.problems.push(`Line ${line}: ${why}`);
  };
  const data = function* () {
    yield* head.slice(header.dataFrom);
    for (let r = it.next(); !r.done; r = it.next()) yield r.value;
  };
  let line = header.dataFrom;

  for (const cells of data()) {
    line++;
    if (cells.every((c) => c.trim() === "")) continue;
    t.rowsRead++;
    if (header.kind === "ptp") {
      const c = header.cols;
      const c1 = (cells[c.c1] ?? "").trim().toUpperCase();
      const c2 = (cells[c.c2] ?? "").trim().toUpperCase();
      if (!NCCI_CODE.test(c1) || !NCCI_CODE.test(c2)) {
        problem(line, `"${c1 || "(blank)"}" and "${c2 || "(blank)"}" are not both five-character codes.`);
        continue;
      }
      const mi = Number((cells[c.modifier] ?? "").trim());
      if (mi !== 0 && mi !== 1 && mi !== 9) {
        problem(line, `the modifier indicator is "${cells[c.modifier] ?? ""}", not 0, 1 or 9.`);
        continue;
      }
      const effective = ncciDate(cells[c.effective]);
      if (!effective) {
        problem(line, `the effective date "${cells[c.effective] ?? ""}" is not a date.`);
        continue;
      }
      const delCell = c.deletion >= 0 ? cells[c.deletion] : "";
      const deletion = noDate(delCell) ? null : ncciDate(delCell);
      if (!noDate(delCell) && !deletion) {
        problem(line, `the deletion date "${delCell ?? ""}" is not a date or "*".`);
        continue;
      }
      if (mi === 9 || (deletion !== null && deletion <= effective) || !known.has(c1) || !known.has(c2)) {
        t.notKept++;
        continue;
      }
      const rationale = c.rationale >= 0 ? (cells[c.rationale] ?? "").trim().slice(0, 300) : "";
      t.ptp.push({ column1: c1, column2: c2, modifierIndicator: mi, effective, deletion, rationale: rationale || null });
    } else {
      const c = header.cols;
      const code = (cells[c.code] ?? "").trim().toUpperCase();
      if (!NCCI_CODE.test(code)) {
        problem(line, `"${code || "(blank)"}" is not a five-character code.`);
        continue;
      }
      const raw = (cells[c.value] ?? "").trim();
      const units = Number(raw);
      if (raw === "" || !Number.isInteger(units) || units < 0 || units > 100_000) {
        problem(line, `the MUE value "${raw}" is not a whole number.`);
        continue;
      }
      const mai = c.mai >= 0 ? Number((cells[c.mai] ?? "").trim().match(/^[123]\b/)?.[0] ?? NaN) : NaN;
      const rationale = c.rationale >= 0 ? (cells[c.rationale] ?? "").trim().slice(0, 300) : "";
      t.mue.push({
        code,
        unitsMax: units,
        adjudication: mai === 1 || mai === 2 || mai === 3 ? mai : null,
        rationale: rationale || null,
      });
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Files as chosen
// ---------------------------------------------------------------------------

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/**
 * Every NCCI table in a chosen file: a ZIP as CMS publishes it (its TXT or
 * CSV, else its XLSX), or a TXT, CSV or XLSX on its own. Files in a ZIP that
 * are not tables (a PDF notice) are passed over.
 */
export async function readNcciFile(name: string, bytes: Uint8Array, known: ReadonlySet<string>): Promise<NcciTable[]> {
  // CMS's pages offer, beside each table, the quarter's changes alone
  // ("Quarterly Additions, Deletions, and Revisions") and the hospital
  // tables: neither is what a practitioner's claims are checked against.
  if (/additions[-_ ,]*(and[-_ ]*)?deletions/i.test(name)) {
    throw new NcciFileError(
      `${name} is CMS's list of this quarter's changes, not the whole table. Choose the Practitioner PTP Edits files (all four) or the Practitioner Services MUE Table.`,
    );
  }
  if (isZip(bytes) && ext(name) !== "xlsx") {
    const entries = await unzip(bytes, name);
    const tables = entries.filter((e) => ["txt", "csv", "xlsx"].includes(ext(e.name)));
    // CMS puts the same rows in a TXT and an XLSX: the text one is read.
    const text = tables.filter((e) => ext(e.name) !== "xlsx");
    const chosen = text.length > 0 ? text : tables;
    const out: NcciTable[] = [];
    for (const e of chosen) out.push(...(await readNcciFile(`${name} › ${e.name}`, e.data, known)));
    if (chosen.length === 0) throw new NcciFileError(`${name} holds no TXT, CSV or XLSX file.`);
    return out;
  }
  const t =
    ext(name) === "xlsx" || isZip(bytes)
      ? readNcciTable(xlsxRows(await unzip(bytes, name), name), name, known)
      : readNcciTable(textRows(decodeText(bytes)), name, known);
  if (t?.setting === "other") {
    throw new NcciFileError(
      `${name} is CMS's MUE table for hospital outpatient or DME claims. Pallio's claims are practitioner claims: choose the Practitioner Services MUE table.`,
    );
  }
  // The PTP header does not say whose table it is; CMS's file names do
  // ("hospital-ptp-edits-ccioph" beside "practitioner-ptp-edits-ccipra").
  if (t?.kind === "ptp" && /hospital|ccioph/i.test(name)) {
    throw new NcciFileError(
      `${name} is CMS's hospital outpatient PTP file. Pallio's claims are practitioner claims: choose the Practitioner PTP Edits files (ccipra).`,
    );
  }
  return t ? [t] : [];
}

/**
 * The parts of CMS's practitioner PTP edits among these file names (CMS
 * splits the quarter's pairs into ...-f1 to ...-f4 by column-1 code). Empty
 * when the names do not say.
 */
export function ptpParts(names: string[]): number[] {
  return [...new Set(names.flatMap((n) => [...n.matchAll(/[-_]f(\d)\b/gi)].map((m) => Number(m[1]))))].sort();
}

/**
 * The quarter an MUE file is for, from its name ("..._Eff_10-01-2026",
 * "2026-10-01", "2026Q4"); null when it does not say.
 */
export function quarterFromName(name: string): string | null {
  let m = name.match(/(\d{1,2})[-_.](\d{1,2})[-_.](20\d{2})/);
  if (m) return isoDate(+m[3]!, +m[1]!, +m[2]!);
  m = name.match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = name.match(/(20\d{2})[-_ ]?q([1-4])/i);
  if (m) return isoDate(+m[1]!, (+m[2]! - 1) * 3 + 1, 1);
  return null;
}

/** The first day of the quarter a date falls in, YYYY-MM-DD. */
export function quarterStart(isoDay: string): string {
  const [y, m] = isoDay.split("-").map(Number) as [number, number];
  return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
}
