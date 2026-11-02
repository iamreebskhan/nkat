/**
 * Reading CMS's NCCI files (0122). Every row here is made up, in the layout of
 * CMS's practitioner files: the pairs, dates and values are not CMS's edits.
 */
import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  NcciFileError,
  ncciDate,
  ptpParts,
  quarterFromName,
  quarterStart,
  readNcciFile,
  readNcciTable,
  textRows,
  unzip,
} from "../ncci-files";

const KNOWN = new Set(["99350", "99497", "G0318", "99349", "99498"]);
const enc = (s: string) => new TextEncoder().encode(s);

/** A ZIP of these files, deflated (or stored), as a zip tool writes one. */
function zip(files: Record<string, string | Uint8Array>, method: 0 | 8 = 8): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc(content) : content;
    const packed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const nameBytes = enc(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The practitioner PTP TXT's layout: notice lines, the header, tab-delimited rows.
const PTP_TXT = [
  "CPT codes, descriptions and other data only are copyright 2025 American Medical Association. All Rights Reserved.",
  "Made-up rows for a test.",
  "",
  "Column 1\tColumn 2\t*=in existence prior to 1996\tEffective Date\tDeletion Date *=no data\tModifier 0=not allowed 1=allowed 9=not applicable\tPTP Edit Rationale",
  "99350\t99497\t\t20240101\t*\t1\tMade-up rationale",
  "99350\t99349\t*\t19960101\t20250701\t0\tMade-up rationale",
  "99350\t11042\t\t20240101\t*\t1\tMade-up rationale",
  "G0318\t99498\t\t20240101\t*\t9\tMade-up rationale",
  "99497\t99498\t\t20240101\t20240101\t1\tMade-up rationale",
  "9935\t99497\t\t20240101\t*\t1\tMade-up rationale",
  "99349\t99497\t\t2024-13-01\t*\t1\tMade-up rationale",
  "",
].join("\r\n");

describe("PTP, as CMS's TXT has it", () => {
  const t = readNcciTable(textRows(PTP_TXT), "ptp-f1.txt", KNOWN)!;

  it("finds the header under the notice and reads every row after it", () => {
    expect(t.kind).toBe("ptp");
    expect(t.rowsRead).toBe(7);
  });

  it("keeps the pairs of codes Pallio knows, with their dates and indicator", () => {
    expect(t.ptp).toEqual([
      { column1: "99350", column2: "99497", modifierIndicator: 1, effective: "2024-01-01", deletion: null, rationale: "Made-up rationale" },
      { column1: "99350", column2: "99349", modifierIndicator: 0, effective: "1996-01-01", deletion: "2025-07-01", rationale: "Made-up rationale" },
    ]);
  });

  it("passes over a code it does not know, indicator 9, and a pair deleted the day it began", () => {
    expect(t.notKept).toBe(3);
  });

  it("says which rows it could not read, by line", () => {
    expect(t.unreadable).toBe(2);
    expect(t.problems).toEqual([
      'Line 10: "9935" and "99497" are not both five-character codes.',
      'Line 11: the effective date "2024-13-01" is not a date.',
    ]);
  });

  it("CONTROL — rows with no NCCI header are not a table", () => {
    expect(readNcciTable(textRows("a\tb\n1\t2\n"), "x.txt", KNOWN)).toBeNull();
  });
});

describe("a header split over two rows", () => {
  it("reads the labels together, and the second row is not counted as data", () => {
    const txt = [
      "Column 1\tColumn 2\t*=in existence\tEffective\tDeletion\tModifier\tPTP Edit",
      "\t\tprior to 1996\tDate\tDate *=no data\t0=not allowed 1=allowed 9=not applicable\tRationale",
      "99350\t99497\t\t20240101\t*\t1\tMade-up",
    ].join("\n");
    const t = readNcciTable(textRows(txt), "two.txt", KNOWN)!;
    expect(t.rowsRead).toBe(1);
    expect(t.unreadable).toBe(0);
    expect(t.ptp).toHaveLength(1);
  });
});

// The practitioner MUE table as CSV: notice, header, quoted cells.
const MUE_CSV = [
  '"CPT codes, descriptions and other data only are copyright 2025 American Medical Association."',
  "",
  "HCPCS/CPT Code,Practitioner Services MUE Values,MUE Adjudication Indicator,MUE Rationale",
  '99350,1,"2 Date of Service Edit: Policy","Made-up, with a comma"',
  "G0318,4,3 Date of Service Edit: Clinical,Made-up",
  "0001F,0,1 Line Edit,Made-up",
  "99497,one,2 Date of Service Edit: Policy,Made-up",
].join("\n");

describe("MUE, as CMS's CSV has it", () => {
  const t = readNcciTable(textRows(MUE_CSV), "mue.csv", KNOWN)!;

  it("keeps every code's value, even one Pallio does not bill", () => {
    expect(t.kind).toBe("mue");
    expect(t.setting).toBe("practitioner");
    expect(t.mue).toEqual([
      { code: "99350", unitsMax: 1, adjudication: 2, rationale: "Made-up, with a comma" },
      { code: "G0318", unitsMax: 4, adjudication: 3, rationale: "Made-up" },
      { code: "0001F", unitsMax: 0, adjudication: 1, rationale: "Made-up" },
    ]);
    expect(t.unreadable).toBe(1);
  });

  it("refuses the hospital outpatient table, which is not for practitioner claims", async () => {
    const csv = MUE_CSV.replace("Practitioner Services MUE Values", "Outpatient Hospital Services MUE Values");
    await expect(readNcciFile("mue-oph.csv", enc(csv), KNOWN)).rejects.toThrow(/Practitioner Services MUE table/);
  });
});

/** A one-sheet XLSX: shared strings for the text, numbers as numbers. */
function xlsx(rows: (string | number)[][]): Uint8Array {
  const strings: string[] = [];
  const sheetRows = rows
    .map((r, i) => {
      const cells = r
        .map((v, k) => {
          const ref = `${String.fromCharCode(65 + k)}${i + 1}`;
          if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
          strings.push(v);
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${i + 1}">${cells}</row>`;
    })
    .join("");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="PTP" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

describe("files as chosen", () => {
  it("reads an XLSX, its dates as numbers or Excel day numbers", async () => {
    const book = xlsx([
      ["Made-up rows & a notice"],
      ["Column 1", "Column 2", "*=in existence prior to 1996", "Effective Date", "Deletion Date *=no data", "Modifier 0=not allowed 1=allowed 9=not applicable", "PTP Edit Rationale"],
      ["99350", "99497", "", 20240101, "*", 1, "Made-up"],
      ["99350", "99349", "", 45292, 45658, 0, "Made-up"],
    ]);
    const [t] = await readNcciFile("ptp.xlsx", book, KNOWN);
    expect(t!.ptp.map((r) => [r.column2, r.effective, r.deletion])).toEqual([
      ["99497", "2024-01-01", null],
      ["99349", "2024-01-01", "2025-01-01"],
    ]);
  });

  it("reads the TXT in CMS's ZIP and passes over its XLSX and PDF copies", async () => {
    const archive = zip({ "ptp-f1.txt": PTP_TXT, "ptp-f1.xlsx": xlsx([["Column 1", "Column 2", "Effective Date", "Modifier"]]), "notice.pdf": "%PDF" });
    const tables = await readNcciFile("ptp-f1.zip", archive, KNOWN);
    expect(tables.map((t) => [t.source, t.ptp.length])).toEqual([["ptp-f1.zip › ptp-f1.txt", 2]]);
  });

  it("reads a stored (uncompressed) ZIP the same", async () => {
    const tables = await readNcciFile("ptp.zip", zip({ "ptp.txt": PTP_TXT }, 0), KNOWN);
    expect(tables[0]!.ptp).toHaveLength(2);
  });

  it("says a cut-off download is damaged", async () => {
    const archive = zip({ "ptp.txt": PTP_TXT });
    await expect(unzip(archive.subarray(0, archive.length - 30), "ptp.zip")).rejects.toThrow(NcciFileError);
  });

  it("refuses the hospital PTP file and the quarter's list of changes, by CMS's names", async () => {
    await expect(readNcciFile("medicare-ncci-2026q4-hospital-ptp-edits-ccioph-v323r0-f1.txt", enc(PTP_TXT), KNOWN)).rejects.toThrow(
      /hospital outpatient PTP file/,
    );
    await expect(
      readNcciFile("practitioner-services-mue-quarterly-additions-deletions-revisions-10012026.zip", enc(MUE_CSV), KNOWN),
    ).rejects.toThrow(/this quarter's changes/);
    // CONTROL: the practitioner file of the same layout is read.
    await expect(readNcciFile("synthetic-ptp-ccipra-f1.txt", enc(PTP_TXT), KNOWN)).resolves.toHaveLength(1);
  });

  it("names the PTP parts chosen", () => {
    expect(ptpParts(["synthetic-ccipra-v1-f2.zip", "synthetic-ccipra-v1-f1.zip › synthetic-ccipra-v1-f1.txt"])).toEqual([1, 2]);
    expect(ptpParts(["mue.csv"])).toEqual([]);
  });

  it("reads a TXT saved as Windows-1252", async () => {
    // 0xE9 alone is not UTF-8: "é" in Windows-1252.
    const latin = new Uint8Array([...enc(PTP_TXT), 0xe9]);
    const [t] = await readNcciFile("ptp.txt", latin, KNOWN);
    expect(t!.ptp).toHaveLength(2);
  });
});

describe("dates and quarters", () => {
  it("reads CMS's form and a spreadsheet's", () => {
    expect(ncciDate("20261001")).toBe("2026-10-01");
    expect(ncciDate("10/01/2026")).toBe("2026-10-01");
    expect(ncciDate("2026-10-01")).toBe("2026-10-01");
    expect(ncciDate("46296")).toBe("2026-10-01");
    expect(ncciDate("20261301")).toBeNull();
    expect(ncciDate("*")).toBeNull();
  });

  it("finds the quarter in an MUE file's name", () => {
    expect(quarterFromName("MCR_MUE_PractitionerServices_Eff_10-01-2026.zip")).toBe("2026-10-01");
    expect(quarterFromName("mue-2026Q3.csv")).toBe("2026-07-01");
    expect(quarterFromName("medicare-ncci-2026-q4-practitioner-services-mue-table.zip")).toBe("2026-10-01");
    expect(quarterFromName("mue.csv")).toBeNull();
    expect(quarterStart("2026-11-17")).toBe("2026-10-01");
  });
});
