/**
 * Fetch a page the way a browser would, for sources that do not exist without
 * JavaScript.
 *
 * Anthem's provider-news articles return 44 KB of HTML that strips down to
 * thirteen characters — "Provider News". The article is assembled client-side,
 * so a plain fetch gets the shell and nothing else. Ingestion used to hash
 * those thirteen characters as the document, send them to Claude, get nothing
 * back, and file the result as "produced no rules", which points the operator
 * at the extractor when the document never arrived. Since 4244ed5 it refuses
 * instead — honest, but the source stays dead either way.
 *
 * Chrome is already running in production for cheat sheets, superbills,
 * patient export and rule PDFs, so this costs no new infrastructure.
 *
 * ONLY ON THE FAILURE PATH. A plain fetch handles every other source in the
 * library; this runs when that fetch produced too little text to be a
 * document. Rendering every source in a browser would be slower, heavier and
 * no more correct.
 *
 * ## The risk, stated plainly
 *
 * This navigates a real browser to a URL an operator registered, and runs
 * whatever script that page carries. The existing puppeteer callers only ever
 * call setContent() with HTML this codebase generated; loading third-party
 * pages is a wider surface than that, and Chrome here runs --no-sandbox
 * because it runs as root on the VPS.
 *
 * What bounds it: only a platform admin can register a source, the browser is
 * launched per call and closed in a finally, each page gets a fresh incognito
 * context with no shared cookies or storage, downloads are refused, and
 * subresources that cannot contribute text — images, media, fonts, stylesheets
 * — are never requested. The text that comes back still goes through the PHI
 * guard before it can reach Anthropic.
 */
import type { Browser } from "puppeteer";

/** Hard ceiling. A page that needs longer than this is not going to render. */
const NAV_TIMEOUT_MS = 30_000;
/** After load, give client-side rendering a moment to put content in the DOM. */
const SETTLE_MS = 2_500;
/**
 * Ceiling on what comes back. fetchUrlBytes caps a download at 32 MB, but a
 * rendered page has no such limit — an infinite-scroll or generated page could
 * hand back arbitrarily much text. Real payer articles are single digits of
 * kilobytes; the Anthem one renders to 9 KB.
 */
const MAX_TEXT = 2_000_000;

export interface BrowserFetchResult {
  /** Rendered text, or "" when the page never produced any. */
  text: string;
  /** The title the rendered document gives itself. */
  title: string | null;
  ok: boolean;
  /** Why it failed, for the operator. null on success. */
  reason: string | null;
}

export async function fetchRenderedText(url: string): Promise<BrowserFetchResult> {
  let browser: Browser | null = null;
  try {
    const puppeteer = (await import("puppeteer")).default;
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // Nothing this page does should outlive the call.
        "--disable-background-networking",
        "--disable-extensions",
        "--mute-audio",
      ],
    });

    // Its own context: no cookies, storage or service workers shared with
    // anything else, and discarded with the browser.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setCacheEnabled(false);

    // Refuse anything that cannot contribute text. Fewer requests, less
    // surface, and a page that tries to pull a binary gets nothing.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
        void req.abort();
      } else {
        void req.continue();
      }
    });

    const res = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });
    if (res && !res.ok()) {
      return { text: "", title: null, ok: false, reason: `HTTP ${res.status()} in browser` };
    }

    // networkidle2 means the requests stopped, not that React has painted.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const { text, title } = await page.evaluate(() => {
      // Whichever container actually HAS the text, not whichever exists.
      // Preferring <main> unconditionally returned 0 characters on Anthem's
      // article, where the shell renders an empty <main> and the content sits
      // elsewhere — so the fallback that would have worked was never reached.
      const candidates = [
        ...document.querySelectorAll("main, article, [role=main]"),
        document.body,
      ];
      let best = "";
      for (const el of candidates) {
        const t = (el as HTMLElement)?.innerText ?? "";
        if (t.length > best.length) best = t;
      }
      return {
        text: best,
        title: document.title || document.querySelector("h1")?.textContent || null,
      };
    });

    return {
      text: (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT),
      title: title ? title.replace(/\s+/g, " ").trim().slice(0, 300) : null,
      ok: true,
      reason: null,
    };
  } catch (e) {
    return {
      text: "",
      title: null,
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // Always. A leaked Chrome on the box outlives the deploy that made it.
    await browser?.close().catch(() => {});
  }
}
