/**
 * A plain .pptx: 16:9 slides of text, tables and native charts. A chart carries
 * its data in an embedded workbook, as one made in PowerPoint does, so "Edit
 * Data" works and nothing on a slide is a pasted picture.
 *
 * Positions are in inches. Text goes through xmlText, so nothing a practice
 * typed can change the file's structure.
 */
import { buildXlsx, xmlText } from "./xlsx-writer";
import { zipStore, type ZipEntry } from "./zip-store";

const EMU = 914_400;
const emu = (inches: number) => Math.round(inches * EMU);

export const SLIDE_WIDTH = 13.333;
export const SLIDE_HEIGHT = 7.5;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export interface PptxParagraph {
  text: string;
  size?: number;
  bold?: boolean;
  /** RRGGBB */
  color?: string;
  bullet?: boolean;
  align?: "left" | "center" | "right";
}

export interface PptxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PptxText extends PptxBox {
  kind: "text";
  paragraphs: PptxParagraph[];
  /** RRGGBB, behind the text. */
  fill?: string;
}

export interface PptxCell {
  text: string;
  bold?: boolean;
  align?: "left" | "right" | "center";
  /** RRGGBB */
  fill?: string;
  /** RRGGBB */
  color?: string;
}

export interface PptxTable extends PptxBox {
  kind: "table";
  /** Column widths in inches. */
  columns: number[];
  rows: PptxCell[][];
  rowHeight: number;
  fontSize: number;
}

export interface PptxSeries {
  name: string;
  values: (number | null)[];
  /** RRGGBB */
  color: string;
}

export interface PptxChart extends PptxBox {
  kind: "chart";
  categories: string[];
  bars: PptxSeries[];
  lines?: PptxSeries[];
  stacked?: boolean;
  horizontal?: boolean;
  /** Excel's format for the value axis. */
  valueFormat: string;
  /** Write each bar's value on it. */
  labels?: boolean;
}

export type PptxShape = PptxText | PptxTable | PptxChart;

export interface PptxSlide {
  /** The slide's title, its title placeholder for outline view and screen readers. */
  title: string;
  /** A cover: the title large, on the brand colour. */
  cover?: boolean;
  shapes: PptxShape[];
}

const THEME = {
  dark: "0F172A",
  brand: "0F766E",
  light: "F8FAFC",
  font: "Calibri",
};

function paragraphXml(p: PptxParagraph): string {
  const size = (p.size ?? 18) * 100;
  const fill = p.color ? `<a:solidFill><a:srgbClr val="${p.color}"/></a:solidFill>` : "";
  const props = `<a:pPr${p.align ? ` algn="${{ left: "l", center: "ctr", right: "r" }[p.align]}"` : ""}${p.bullet ? ' marL="285750" indent="-285750"' : ""}>${
    p.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : "<a:buNone/>"
  }</a:pPr>`;
  return `<a:p>${props}<a:r><a:rPr lang="en-US" sz="${size}"${p.bold ? ' b="1"' : ""} dirty="0">${fill}</a:rPr><a:t>${xmlText(p.text)}</a:t></a:r></a:p>`;
}

const xfrm = (b: PptxBox, tag = "a:xfrm") => `<${tag}><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${emu(b.w)}" cy="${emu(b.h)}"/></${tag}>`;

function textShape(s: PptxText, id: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(s)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${s.fill ? `<a:solidFill><a:srgbClr val="${s.fill}"/></a:solidFill>` : "<a:noFill/>"}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${s.paragraphs.map(paragraphXml).join("")}</p:txBody></p:sp>`
  );
}

function tableShape(s: PptxTable, id: number): string {
  const grid = s.columns.map((w) => `<a:gridCol w="${emu(w)}"/>`).join("");
  // Only a line under each row: with none set, PowerPoint draws its black grid.
  const none = (tag: string) => `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
  const borders = `${none("lnL")}${none("lnR")}${none("lnT")}<a:lnB w="6350"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnB>`;
  const rows = s.rows.map((cells) => {
    const tcs = cells.map((c) => {
      const color = c.color ?? "0F172A";
      return (
        `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${{ left: "l", center: "ctr", right: "r" }[c.align ?? "left"]}"/>` +
        `<a:r><a:rPr lang="en-US" sz="${s.fontSize * 100}"${c.bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlText(c.text)}</a:t></a:r>` +
        `</a:p></a:txBody><a:tcPr marL="54864" marR="54864" marT="18288" marB="18288" anchor="ctr">${borders}${c.fill ? `<a:solidFill><a:srgbClr val="${c.fill}"/></a:solidFill>` : "<a:noFill/>"}</a:tcPr></a:tc>`
      );
    });
    return `<a:tr h="${emu(s.rowHeight)}">${tcs.join("")}</a:tr>`;
  });
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrm(s, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows.join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function chartFrame(s: PptxChart, id: number, rel: string): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrm(s, "p:xfrm")}<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="${rel}"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

const columnName = (n: number) => String.fromCharCode(65 + n);

function chartXml(c: PptxChart): string {
  const last = c.categories.length + 1;
  const strCache = (items: string[]) =>
    `<c:strCache><c:ptCount val="${items.length}"/>${items.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlText(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
  const numCache = (items: (number | null)[]) =>
    `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${items.length}"/>${items.map((v, i) => (v === null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("")}</c:numCache>`;
  const cat = `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${last}</c:f>${strCache(c.categories)}</c:strRef></c:cat>`;
  const series = (s: PptxSeries, index: number, body: string, after: string) => {
    const col = columnName(index + 1);
    return (
      `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>Sheet1!$${col}$1</c:f>${strCache([s.name])}</c:strRef></c:tx>${body}${cat}` +
      `<c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$${last}</c:f>${numCache(s.values)}</c:numRef></c:val>${after}</c:ser>`
    );
  };
  const dataLabels = c.labels
    ? `<c:dLbls><c:numFmt formatCode="${xmlText(c.valueFormat)}" sourceLinked="0"/><c:spPr><a:noFill/></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`
    : "";
  const bars = c.bars.map((s, i) =>
    series(s, i, `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>${dataLabels}`, ""),
  );
  const lines = (c.lines ?? []).map((s, i) =>
    series(
      s,
      c.bars.length + i,
      `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:prstDash val="dash"/><a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`,
      '<c:smooth val="0"/>',
    ),
  );
  const grouping = c.stacked ? "stacked" : "clustered";
  const overlap = c.stacked ? '<c:overlap val="100"/>' : "";
  const catAxisPos = c.horizontal ? "l" : "b";
  const valAxisPos = c.horizontal ? "b" : "l";
  const txPr = (size: number) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size * 100}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
  const showLegend = c.bars.length + (c.lines?.length ?? 0) > 1;
  // Bars with their value written on them need no axis; small counts step by one, or 0, 0, 1, 1 prints.
  const gridlines = c.labels ? "" : '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';
  const top = Math.max(0, ...[...c.bars, ...(c.lines ?? [])].flatMap((s) => s.values.map((v) => v ?? 0)));
  const stepOne = c.valueFormat === "#,##0" && top < 10 ? '<c:majorUnit val="1"/>' : "";
  return (
    XML_HEAD +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>` +
    `<c:barChart><c:barDir val="${c.horizontal ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${bars.join("")}<c:gapWidth val="45"/>${overlap}<c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>` +
    (lines.length ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${lines.join("")}<c:marker val="1"/><c:axId val="111111111"/><c:axId val="222222222"/></c:lineChart>` : "") +
    `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="${c.horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${catAxisPos}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill></a:ln></c:spPr>${txPr(c.categories.length > 18 ? 9 : 11)}<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="${c.labels ? 1 : 0}"/><c:axPos val="${valAxisPos}"/>${gridlines}<c:numFmt formatCode="${xmlText(c.valueFormat)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(11)}<c:crossAx val="111111111"/><c:crosses val="${c.horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/>${stepOne}</c:valAx>` +
    `</c:plotArea>${showLegend ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(12)}</c:legend>` : ""}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`
  );
}

function chartWorkbook(c: PptxChart): Uint8Array {
  const all = [...c.bars, ...(c.lines ?? [])];
  return buildXlsx([
    {
      name: "Sheet1",
      rows: [[" ", ...all.map((s) => s.name)], ...c.categories.map((cat, i) => [cat, ...all.map((s) => s.values[i] ?? null)])],
      widths: [28, ...all.map(() => 16)],
    },
  ]);
}

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function titleShape(text: string, cover: boolean): string {
  const box: PptxBox = cover ? { x: 0.75, y: 2.2, w: 11.8, h: 1.5 } : { x: 0.5, y: 0.3, w: 12.33, h: 0.85 };
  const run = cover ? '<a:rPr lang="en-US" sz="4800" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>' : '<a:rPr lang="en-US" dirty="0"/>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${run}<a:t>${xmlText(text)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

function slideXml(s: PptxSlide, chartRels: Map<PptxChart, string>): string {
  const shapes = s.shapes.map((shape, i) => {
    const id = i + 3;
    if (shape.kind === "text") return textShape(shape, id);
    if (shape.kind === "table") return tableShape(shape, id);
    return chartFrame(shape, id, chartRels.get(shape)!);
  });
  const bg = s.cover ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${THEME.brand}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : "";
  return (
    XML_HEAD +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>${bg}<p:spTree>${GROUP}${titleShape(s.title, Boolean(s.cover))}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

const rels = (items: { id: string; type: string; target: string }[]) =>
  XML_HEAD +
  `<Relationships xmlns="${NS_REL}">${items.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;

const themeXml = () => {
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const lines = '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3);
  const effects = "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3);
  return (
    XML_HEAD +
    `<a:theme xmlns:a="${NS_A}" name="Pallio"><a:themeElements><a:clrScheme name="Pallio">` +
    `<a:dk1><a:srgbClr val="${THEME.dark}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="${THEME.light}"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="${THEME.brand}"/></a:accent1><a:accent2><a:srgbClr val="0369A1"/></a:accent2><a:accent3><a:srgbClr val="B45309"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="BE123C"/></a:accent5><a:accent6><a:srgbClr val="4D7C0F"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0369A1"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>` +
    `<a:fontScheme name="Pallio"><a:majorFont><a:latin typeface="${THEME.font}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${THEME.font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Pallio"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${effects}</a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements></a:theme>`
  );
};

const levelStyle = (size: number, bold: boolean, color: string) =>
  `<a:lvl1pPr algn="l"><a:defRPr sz="${size * 100}" b="${bold ? 1 : 0}"><a:solidFill><a:schemeClr val="${color}"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`;

const masterXml = () =>
  XML_HEAD +
  `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 0.5, y: 0.3, w: 12.33, h: 0.85 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle>${levelStyle(30, true, "accent1")}</p:titleStyle><p:bodyStyle>${levelStyle(18, false, "tx1")}</p:bodyStyle><p:otherStyle>${levelStyle(18, false, "tx1")}</p:otherStyle></p:txStyles></p:sldMaster>`;

const layoutXml = () =>
  XML_HEAD +
  `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="titleOnly" preserve="1"><p:cSld name="Title only"><p:spTree>${GROUP}` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const T = "application/vnd.openxmlformats-officedocument";
const R = `${NS_R}`;

export function buildPptx(slides: PptxSlide[]): Uint8Array {
  if (slides.length === 0) throw new Error("A deck needs a slide.");
  const charts = slides.flatMap((s) => s.shapes.filter((x): x is PptxChart => x.kind === "chart"));
  const chartNumber = new Map(charts.map((c, i) => [c, i + 1]));

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data:
        XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="xlsx" ContentType="${T}.spreadsheetml.sheet"/>` +
        `<Override PartName="/ppt/presentation.xml" ContentType="${T}.presentationml.presentation.main+xml"/>` +
        `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${T}.presentationml.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${T}.presentationml.slideLayout+xml"/>` +
        `<Override PartName="/ppt/theme/theme1.xml" ContentType="${T}.theme+xml"/>` +
        slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${T}.presentationml.slide+xml"/>`).join("") +
        charts.map((_, i) => `<Override PartName="/ppt/charts/chart${i + 1}.xml" ContentType="${T}.drawingml.chart+xml"/>`).join("") +
        "</Types>",
    },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: `${R}/officeDocument`, target: "ppt/presentation.xml" }]) },
    {
      name: "ppt/presentation.xml",
      data:
        XML_HEAD +
        `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
        `<p:sldSz cx="${emu(SLIDE_WIDTH)}" cy="${emu(SLIDE_HEIGHT)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: rels([
        { id: "rId1", type: `${R}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
        ...slides.map((_, i) => ({ id: `rId${i + 2}`, type: `${R}/slide`, target: `slides/slide${i + 1}.xml` })),
        { id: `rId${slides.length + 2}`, type: `${R}/theme`, target: "theme/theme1.xml" },
      ]),
    },
    { name: "ppt/theme/theme1.xml", data: themeXml() },
    { name: "ppt/slideMasters/slideMaster1.xml", data: masterXml() },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: rels([
        { id: "rId1", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: `${R}/theme`, target: "../theme/theme1.xml" },
      ]),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layoutXml() },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([{ id: "rId1", type: `${R}/slideMaster`, target: "../slideMasters/slideMaster1.xml" }]) },
  ];

  slides.forEach((s, i) => {
    const own = s.shapes.filter((x): x is PptxChart => x.kind === "chart");
    const chartRels = new Map(own.map((c, k) => [c, `rId${k + 2}`]));
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s, chartRels) });
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: rels([
        { id: "rId1", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        ...own.map((c, k) => ({ id: `rId${k + 2}`, type: `${R}/chart`, target: `../charts/chart${chartNumber.get(c)}.xml` })),
      ]),
    });
  });

  charts.forEach((c, i) => {
    const n = i + 1;
    entries.push({ name: `ppt/charts/chart${n}.xml`, data: chartXml(c) });
    entries.push({ name: `ppt/charts/_rels/chart${n}.xml.rels`, data: rels([{ id: "rId1", type: `${R}/package`, target: `../embeddings/Microsoft_Excel_Sheet${n}.xlsx` }]) });
    entries.push({ name: `ppt/embeddings/Microsoft_Excel_Sheet${n}.xlsx`, data: chartWorkbook(c) });
  });

  return zipStore(entries);
}
