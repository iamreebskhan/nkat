/**
 * The board report as files, all from one BoardReport: a workbook for the
 * practice to keep and check, a deck with native charts and tables, and the
 * same slides as HTML for the PDF. Pure.
 */
import { boardMonthLabel, type BoardChart, type BoardReport, type BoardRow, type BoardTable } from "./board-report";
import { formatKpi } from "./kpi-report";
import { ENTERED, HEAD, HEAD_RIGHT, kpiCell, NOTE, SECTION, TITLE } from "./kpi-workbook";
import { yearChange, type KpiYearOverYear } from "./kpi-year-over-year";
import { buildPptx, SLIDE_WIDTH, type PptxCell, type PptxSlide, type PptxTable } from "./pptx-writer";
import { buildXlsx, type CellInput, type Sheet } from "./xlsx-writer";

const BRAND = "0F766E";
const PLAN = "B45309";
const SECOND = "94A3B8";
const HEADER_FILL = "334155";
const TOTAL_FILL = "E2E8F0";

/** "Jan to Jun 2026" */
const periodOf = (y: KpiYearOverYear) => {
  const label = (r: { fromDate: string; toDate: string }) => {
    const last = boardMonthLabel(r.toDate.slice(0, 7)).split(" ");
    return `${boardMonthLabel(r.fromDate.slice(0, 7)).slice(0, 3)} to ${last[0]!.slice(0, 3)} ${last[1]}`;
  };
  return { prior: label(y.prior), current: label(y.current) };
};

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

function tableRows(t: BoardTable): CellInput[][] {
  const hasTotal = t.rows.some((r) => r.total !== undefined);
  const head: CellInput[] = [{ v: t.title, s: HEAD }, ...t.columns.map((c) => ({ v: c, s: HEAD_RIGHT })), ...(hasTotal ? [{ v: "Total", s: HEAD_RIGHT }] : [])];
  const body = t.rows.map((r: BoardRow): CellInput[] => {
    if (r.heading) return [{ v: r.label, s: SECTION }, ...Array.from({ length: t.columns.length + (hasTotal ? 1 : 0) }, () => ({ v: null, s: SECTION }))];
    const total = r.label === "Total";
    return [
      { v: r.label, s: total ? { bold: true } : {} },
      ...r.values.map((v, k) => kpiCell(v, r.unit, { ...(total ? { bold: true } : {}), ...(r.entered?.includes(k) ? ENTERED : {}) })),
      ...(hasTotal ? [kpiCell(r.total ?? null, r.unit, { bold: true })] : []),
    ];
  });
  return [head, ...body];
}

function planSheet(b: BoardReport): Sheet {
  return {
    name: "Plan vs actual",
    rows: [
      [{ v: `${b.orgName}: plan vs actual, to ${b.monthLabel}`, s: TITLE }],
      [{ v: "Computed from Pallio's months. Shaded months were entered by hand on Monthly history.", s: NOTE }],
      ...tableRows(b.planVsActual),
    ],
    widths: [34, ...b.planVsActual.columns.map(() => 10)],
    freeze: { rows: 3, columns: 1 },
  };
}

function reasonsSheet(b: BoardReport): Sheet {
  return {
    name: "Discharges and NTUC",
    rows: [
      [{ v: `${b.orgName}: discharges and not taken under care, ${b.monthLabel.split(" ")[1]}`, s: TITLE }],
      [{ v: "By the day discharged, and the day closed. Shaded months were entered by hand.", s: NOTE }],
      ...tableRows(b.discharges),
      [],
      ...tableRows(b.ntuc),
    ],
    widths: [46, ...b.discharges.columns.map(() => 9), 9],
  };
}

function yearSheet(b: BoardReport): Sheet {
  const p = periodOf(b.year);
  return {
    name: "Year over year",
    rows: [
      [{ v: `${b.orgName}: year over year, to ${b.monthLabel}`, s: TITLE }],
      [{ v: `Per-month rows divide by ${Math.round(b.year.months * 100) / 100} months. Every figure is computed from the months on the first sheet.`, s: NOTE }],
      [{ v: "Palliative care trends", s: HEAD }, { v: p.prior, s: HEAD_RIGHT }, { v: p.current, s: HEAD_RIGHT }, { v: "Change", s: HEAD_RIGHT }, { v: "Comments", s: HEAD }],
      ...b.year.rows.map((r): CellInput[] => [{ v: r.label, s: { bold: true } }, kpiCell(r.prior, r.unit), kpiCell(r.current, r.unit), { v: yearChange(r), s: { align: "right" } }]),
    ],
    widths: [46, 20, 20, 12, 50],
  };
}

function exceptionsSheet(b: BoardReport): Sheet {
  return {
    name: "Exceptions",
    rows: [
      [{ v: `Check before this goes anywhere: ${b.monthLabel}`, s: TITLE }],
      [{ v: "None of these changes a figure. Each is something a person should look at.", s: NOTE }],
      [{ v: "Month", s: HEAD }, { v: "What to check", s: HEAD }],
      ...(b.exceptions.length > 0
        ? b.exceptions.map((e): CellInput[] => [e.month ?? "", { v: e.text, s: { wrap: true } }])
        : ([["", "Nothing to check."]] as CellInput[][])),
    ],
    widths: [12, 110],
  };
}

export const boardWorkbook = (b: BoardReport): Uint8Array => buildXlsx([planSheet(b), reasonsSheet(b), yearSheet(b), exceptionsSheet(b)]);

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

const CONTENT = { x: 0.5, y: 1.25, w: SLIDE_WIDTH - 1, h: 5.85 };

function reasonSlide(t: BoardTable): PptxTable {
  const n = t.columns.length + 1;
  const cell = Math.min(0.72, (CONTENT.w - 3.8) / n);
  const columns = [CONTENT.w - cell * n, ...Array.from({ length: n }, () => cell)];
  const zero = (v: number | null | undefined) => (v ? formatKpi(v, "count") : "");
  const head: PptxCell[] = [{ text: "Reason", bold: true, fill: HEADER_FILL, color: "FFFFFF" }, ...t.columns.map((c): PptxCell => ({ text: c, bold: true, align: "right", fill: HEADER_FILL, color: "FFFFFF" })), { text: "Total", bold: true, align: "right", fill: HEADER_FILL, color: "FFFFFF" }];
  const rows = t.rows.map((r): PptxCell[] => {
    const total = r.label === "Total";
    const fill = total ? TOTAL_FILL : undefined;
    return [{ text: r.label, bold: total, fill }, ...r.values.map((v): PptxCell => ({ text: total ? formatKpi(v, "count") : zero(v), align: "right", bold: total, fill })), { text: formatKpi(r.total ?? 0, "count"), align: "right", bold: true, fill }];
  });
  const rowHeight = Math.min(0.36, CONTENT.h / (rows.length + 1));
  return { kind: "table", ...CONTENT, h: rowHeight * (rows.length + 1), columns, rows: [head, ...rows], rowHeight, fontSize: rows.length > 13 ? 11 : 12 };
}

function yearSlide(b: BoardReport): PptxTable {
  const p = periodOf(b.year);
  const head = (text: string, align: PptxCell["align"] = "right"): PptxCell => ({ text, bold: true, align, fill: HEADER_FILL, color: "FFFFFF" });
  const rows = b.year.rows.map((r): PptxCell[] => [
    { text: r.label },
    { text: formatKpi(r.prior, r.unit), align: "right" },
    { text: formatKpi(r.current, r.unit), align: "right", bold: true },
    { text: yearChange(r), align: "right" },
  ]);
  return { kind: "table", ...CONTENT, h: 0.38 * 15, columns: [6.13, 2.3, 2.3, 1.6], rows: [[head("Palliative care trends", "left"), head(p.prior), head(p.current), head("Change")], ...rows], rowHeight: 0.38, fontSize: 14 };
}

const chartShape = (c: BoardChart, valueFormat: string, stacked = false) => ({
  kind: "chart" as const,
  ...CONTENT,
  categories: c.categories,
  bars: c.bars.map((s, i) => ({ ...s, color: i === 0 ? BRAND : SECOND })),
  lines: c.lines.map((s) => ({ ...s, color: PLAN })),
  stacked,
  valueFormat,
});

function deckSlides(b: BoardReport): PptxSlide[] {
  const sources: PptxSlide["shapes"] =
    b.sources.length > 0
      ? [
          {
            kind: "chart",
            ...CONTENT,
            categories: b.sources.map((s) => s.label),
            bars: [{ name: "Referrals", values: b.sources.map((s) => s.referrals), color: BRAND }],
            horizontal: true,
            labels: true,
            valueFormat: "#,##0",
          },
        ]
      : [{ kind: "text", ...CONTENT, paragraphs: [{ text: "No referral sources are recorded for these months.", size: 20, color: "475569" }] }];
  return [
    {
      title: b.orgName,
      cover: true,
      shapes: [
        {
          kind: "text", x: 0.75, y: 3.8, w: 11.8, h: 1.6,
          paragraphs: [
            { text: "Monthly Status Summary", size: 26, color: "FFFFFF" },
            { text: b.monthLabel, size: 26, color: "FFFFFF", bold: true },
          ],
        },
      ],
    },
    {
      title: "Celebrations",
      shapes: [
        {
          kind: "text", ...CONTENT,
          paragraphs: [...b.celebrations, ...b.highlights].map((text) => ({ text, size: 24, bullet: true })),
        },
      ],
    },
    { title: "Billing", shapes: [chartShape(b.billing, '"$"#,##0')] },
    { title: "Palliative census", shapes: [chartShape(b.census, "#,##0")] },
    { title: "Year over year", shapes: [yearSlide(b)] },
    { title: "Referrals by outcome", shapes: [chartShape(b.pipeline, "#,##0", true)] },
    { title: "Referral sources, past 12 months", shapes: sources },
    { title: "Not taken under care", shapes: [reasonSlide(b.ntuc)] },
    { title: "Discharges from palliative care", shapes: [reasonSlide(b.discharges)] },
  ];
}

export const boardDeck = (b: BoardReport): Uint8Array => buildPptx(deckSlides(b));

// ---------------------------------------------------------------------------
// The PDF's slides
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Round steps from zero to at or above the highest value, about four of them, never less than 1. */
export function chartTicks(max: number): number[] {
  const rough = Math.max(max, 1) / 4;
  const unit = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].find((s) => s * unit >= rough)! * unit);
  return Array.from({ length: Math.ceil(Math.max(max, 1) / step) + 1 }, (_, i) => i * step);
}

/** A bar chart with optional dashed lines, as SVG. Stacked bars add up; side-by-side is not needed here. */
function svgChart(c: BoardChart, format: (v: number) => string, stacked = false): string {
  const W = 1180;
  const H = 500;
  const left = 70;
  const bottom = 56;
  const top = 14;
  const plotW = W - left - 12;
  const plotH = H - top - bottom;
  const n = c.categories.length;
  const heights = c.categories.map((_, k) => c.bars.reduce((sum, s) => sum + (s.values[k] ?? 0), 0));
  const ticks = chartTicks(Math.max(0, ...heights, ...c.lines.flatMap((l) => l.values.map((v) => v ?? 0))));
  const max = ticks.at(-1)!;
  const x = (k: number) => left + (plotW / n) * k;
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const barW = (plotW / n) * 0.7;
  const grid = ticks.map((v) => {
    return `<line x1="${left}" x2="${W - 12}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0"/><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="13" fill="#475569">${esc(format(v))}</text>`;
  });
  const colors = [`#${BRAND}`, `#${SECOND}`];
  const bars = c.categories.map((_, k) => {
    let base = 0;
    return c.bars
      .map((s, i) => {
        const v = s.values[k] ?? 0;
        const from = stacked ? base : 0;
        base += v;
        return `<rect x="${x(k) + (plotW / n - barW) / 2}" y="${y(from + v)}" width="${barW}" height="${Math.max(0, y(from) - y(from + v))}" fill="${colors[i] ?? colors[0]}"/>`;
      })
      .join("");
  });
  const every = n > 18 ? 3 : 1;
  const labels = c.categories.map((m, k) => (k % every === 0 ? `<text x="${x(k) + plotW / n / 2}" y="${H - bottom + 20}" text-anchor="middle" font-size="13" fill="#475569">${esc(m)}</text>` : ""));
  const lines = c.lines.map((l) => {
    const points = l.values.flatMap((v, k) => (v === null ? [] : [`${x(k) + plotW / n / 2},${y(v)}`]));
    return `<polyline points="${points.join(" ")}" fill="none" stroke="#${PLAN}" stroke-width="3" stroke-dasharray="9 6"/>`;
  });
  const keys = [...c.bars.map((s, i) => [s.name, colors[i] ?? colors[0]] as const), ...c.lines.map((l) => [l.name, `#${PLAN}`] as const)];
  const legend = keys.length > 1 ? keys.map(([name, color], i) => `<rect x="${left + i * 230}" y="${H - 20}" width="14" height="14" fill="${color}"/><text x="${left + i * 230 + 20}" y="${H - 8}" font-size="14" fill="#0f172a">${esc(name)}</text>`) : [];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(c.title)}">${grid.join("")}${bars.join("")}${lines.join("")}${labels.join("")}${legend.join("")}</svg>`;
}

function htmlReasonTable(t: BoardTable): string {
  const cell = (v: number | null | undefined, total: boolean) => (v || total ? formatKpi(v ?? 0, "count") : "");
  const rows = t.rows.map((r) => {
    const total = r.label === "Total";
    return `<tr class="${total ? "total" : ""}"><td>${esc(r.label)}</td>${r.values.map((v) => `<td class="n">${cell(v, total)}</td>`).join("")}<td class="n b">${formatKpi(r.total ?? 0, "count")}</td></tr>`;
  });
  return `<table><thead><tr><th>Reason</th>${t.columns.map((c) => `<th class="n">${esc(c)}</th>`).join("")}<th class="n">Total</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function boardHtml(b: BoardReport): string {
  const page = (title: string, body: string) => `<section class="slide"><h1>${esc(title)}</h1>${body}</section>`;
  const p = periodOf(b.year);
  const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const count = (v: number) => Math.round(v).toLocaleString("en-US");
  const yearRows = b.year.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${formatKpi(r.prior, r.unit)}</td><td class="n b">${formatKpi(r.current, r.unit)}</td><td class="n">${esc(yearChange(r))}</td></tr>`);
  const top = Math.max(1, ...b.sources.map((s) => s.referrals));
  const sources = b.sources.length
    ? `<div class="sources">${b.sources.map((s) => `<div class="src"><span class="name">${esc(s.label)}</span><span class="bar"><i style="width:${(s.referrals / top) * 100}%"></i></span><span class="n">${s.referrals}</span></div>`).join("")}</div>`
    : `<p class="quiet">No referral sources are recorded for these months.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(b.orgName)}: ${esc(b.monthLabel)}</title><style>
    @page { size: 13.333in 7.5in; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Calibri, "Segoe UI", Arial, sans-serif; color: #0f172a; }
    .slide { width: 13.333in; height: 7.5in; padding: .35in .5in; page-break-after: always; overflow: hidden; }
    .slide:last-child { page-break-after: auto; }
    h1 { margin: 0 0 .2in; font-size: 30pt; color: #${BRAND}; }
    .cover { background: #${BRAND}; color: #fff; padding: 2.2in .75in; }
    .cover h1 { color: #fff; font-size: 48pt; margin-bottom: .3in; }
    .cover p { margin: 0; font-size: 26pt; }
    ul { margin: .2in 0 0; font-size: 24pt; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; font-size: 13pt; }
    th { background: #${HEADER_FILL}; color: #fff; text-align: left; padding: 5px 8px; }
    td { padding: 4px 8px; border-bottom: 1px solid #cbd5e1; }
    .n { text-align: right; font-variant-numeric: tabular-nums; }
    .b { font-weight: 700; }
    .total td { background: #${TOTAL_FILL}; font-weight: 700; }
    .big { font-size: 15pt; }
    .quiet { font-size: 20pt; color: #475569; }
    .sources { font-size: 15pt; }
    .src { display: grid; grid-template-columns: 4.2in 1fr .7in; gap: .15in; align-items: center; padding: .08in 0; }
    .bar { display: block; height: .28in; background: #f1f5f9; }
    .bar i { display: block; height: 100%; background: #${BRAND}; }
  </style></head><body>
  <section class="slide cover"><h1>${esc(b.orgName)}</h1><p>Monthly Status Summary</p><p><strong>${esc(b.monthLabel)}</strong></p></section>
  ${page("Celebrations", `<ul>${[...b.celebrations, ...b.highlights].map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`)}
  ${page("Billing", svgChart(b.billing, money))}
  ${page("Palliative census", svgChart(b.census, count))}
  ${page("Year over year", `<table class="big"><thead><tr><th>Palliative care trends</th><th class="n">${esc(p.prior)}</th><th class="n">${esc(p.current)}</th><th class="n">Change</th></tr></thead><tbody>${yearRows.join("")}</tbody></table>`)}
  ${page("Referrals by outcome", svgChart(b.pipeline, count, true))}
  ${page("Referral sources, past 12 months", sources)}
  ${page("Not taken under care", htmlReasonTable(b.ntuc))}
  ${page("Discharges from palliative care", htmlReasonTable(b.discharges))}
  </body></html>`;
}

export const boardFileName = (b: Pick<BoardReport, "month">, format: string) => `pallio-board-report-${b.month}.${format}`;
