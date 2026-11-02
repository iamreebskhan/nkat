/**
 * A plain .xlsx: sheets of values and styles, nothing else.
 *
 * Text goes as inline strings, so a cell is only ever text or a number and
 * nothing a practice typed can become a formula. A style is a small object; the
 * distinct ones become the workbook's style table.
 */
import { zipStore } from "./zip-store";

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  /** RRGGBB */
  color?: string;
  size?: number;
  /** RRGGBB */
  fill?: string;
  align?: "left" | "right" | "center";
  indent?: number;
  wrap?: boolean;
  /** An Excel number format. */
  format?: string;
  /** A line under the cell. */
  underline?: boolean;
}

export interface Cell {
  v: string | number | null;
  s?: CellStyle;
}

export type CellInput = Cell | string | number | null;

export interface Sheet {
  /** At most 31 characters, none of []:*?/\ (cut and replaced here). */
  name: string;
  rows: CellInput[][];
  /** Column widths in characters, from column A. */
  widths?: number[];
  /** Rows and columns kept in view as the sheet scrolls. */
  freeze?: { rows: number; columns: number };
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Text as XML allows it: control characters have no place even when escaped. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → A, 26 → AA */
export function columnName(n: number): string {
  let s = "";
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
}

const sheetName = (name: string, used: Set<string>): string => {
  const clean = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let out = clean;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${clean.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(out.toLowerCase());
  return out;
};

/** The workbook's style table: each distinct style, and what it is made of. */
class Styles {
  private fonts = new Map<string, number>([["", 0]]);
  private fills = new Map<string, number>([["", 0], ["gray125", 1]]);
  private borders = new Map<string, number>([["", 0]]);
  private formats = new Map<string, number>();
  private xfs = new Map<string, number>([["{}", 0]]);
  private xfXml: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];

  private fontXml = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  private fillXml = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  private borderXml = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];

  private id(map: Map<string, number>, key: string, add: () => void): number {
    const found = map.get(key);
    if (found !== undefined) return found;
    const id = map.size;
    map.set(key, id);
    add();
    return id;
  }

  index(s: CellStyle | undefined): number {
    if (!s) return 0;
    const key = JSON.stringify(s);
    const found = this.xfs.get(key);
    if (found !== undefined) return found;

    const fontKey = [s.bold, s.italic, s.color, s.size].join("|");
    const font =
      s.bold || s.italic || s.color || s.size
        ? this.id(this.fonts, fontKey, () =>
            this.fontXml.push(
              `<font>${s.bold ? "<b/>" : ""}${s.italic ? "<i/>" : ""}<sz val="${s.size ?? 11}"/>${s.color ? `<color rgb="FF${s.color}"/>` : ""}<name val="Calibri"/><family val="2"/></font>`,
            ),
          )
        : 0;
    const fill = s.fill
      ? this.id(this.fills, s.fill, () =>
          this.fillXml.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`),
        )
      : 0;
    const border = s.underline
      ? this.id(this.borders, "under", () =>
          this.borderXml.push('<border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border>'),
        )
      : 0;
    const numFmt = s.format ? this.id(this.formats, s.format, () => undefined) + 164 : 0;

    const aligned = s.align || s.indent || s.wrap;
    const alignment = aligned
      ? `<alignment${s.align ? ` horizontal="${s.align}"` : ""}${s.indent ? ` horizontal="left" indent="${s.indent}"` : ""}${s.wrap ? ' wrapText="1" vertical="top"' : ""}/>`
      : "";
    const xf = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ""}${font ? ' applyFont="1"' : ""}${fill ? ' applyFill="1"' : ""}${border ? ' applyBorder="1"' : ""}${aligned ? ' applyAlignment="1"' : ""}${alignment ? `>${alignment}</xf>` : "/>"}`;
    const id = this.xfXml.length;
    this.xfXml.push(xf);
    this.xfs.set(key, id);
    return id;
  }

  xml(): string {
    const formats = [...this.formats.entries()].map(([code, i]) => `<numFmt numFmtId="${i + 164}" formatCode="${xmlText(code)}"/>`);
    return (
      XML_HEAD +
      `<styleSheet xmlns="${NS}">` +
      (formats.length ? `<numFmts count="${formats.length}">${formats.join("")}</numFmts>` : "") +
      `<fonts count="${this.fontXml.length}">${this.fontXml.join("")}</fonts>` +
      `<fills count="${this.fillXml.length}">${this.fillXml.join("")}</fills>` +
      `<borders count="${this.borderXml.length}">${this.borderXml.join("")}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfXml.length}">${this.xfXml.join("")}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }
}

const asCell = (c: CellInput): Cell => (c !== null && typeof c === "object" ? c : { v: c });

function sheetXml(sheet: Sheet, styles: Styles): string {
  const rows = sheet.rows.map((cells, r) => {
    const body = cells
      .map((input, c) => {
        const cell = asCell(input);
        const s = styles.index(cell.s);
        const ref = `${columnName(c)}${r + 1}`;
        const style = s ? ` s="${s}"` : "";
        if (cell.v === null || cell.v === "") return s ? `<c r="${ref}"${style}/>` : "";
        if (typeof cell.v === "number") return Number.isFinite(cell.v) ? `<c r="${ref}"${style}><v>${cell.v}</v></c>` : `<c r="${ref}"${style}/>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.v)}</t></is></c>`;
      })
      .join("");
    return `<row r="${r + 1}">${body}</row>`;
  });
  const f = sheet.freeze;
  const pane =
    f && (f.rows > 0 || f.columns > 0)
      ? `<pane${f.columns ? ` xSplit="${f.columns}"` : ""}${f.rows ? ` ySplit="${f.rows}"` : ""} topLeftCell="${columnName(f.columns)}${f.rows + 1}" activePane="${f.rows && f.columns ? "bottomRight" : f.rows ? "bottomLeft" : "topRight"}" state="frozen"/>`
      : "";
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  return (
    XML_HEAD +
    `<worksheet xmlns="${NS}"><sheetViews><sheetView showGridLines="0" workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs a sheet.");
  const styles = new Styles();
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, used) }));
  const bodies = named.map((s) => sheetXml(s, styles));
  return zipStore([
    {
      name: "[Content_Types].xml",
      data:
        XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/>` +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      data:
        XML_HEAD +
        `<workbook xmlns="${NS}" xmlns:r="${RELS}"><sheets>` +
        named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets></workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${named.length + 1}" Type="${RELS}/styles" Target="styles.xml"/>` +
        "</Relationships>",
    },
    { name: "xl/styles.xml", data: styles.xml() },
    ...bodies.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ]);
}
