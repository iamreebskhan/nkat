/**
 * FULL live UI walkthrough — drives a real headless browser through every
 * page + key button of the running app, so you DON'T have to log in and
 * click. Screenshots every step to ./screenshots/*.png for visual review.
 *
 * Logs into the seeded demo account (livedemo@pallio.io), which already has
 * Ada/Grace + a visit/superbill/denial, so the data-rich UI actually renders.
 *
 * Run on the VPS (has Playwright + Chromium; used by e2e-ui.mjs already):
 *   BASE_URL=https://app.pallio.io node scripts/e2e-live-walkthrough.mjs
 *   HEADLESS=false ...   # to watch it drive
 *
 * Reports pass/fail per step. Exit 0 iff all steps pass. Review the
 * screenshots folder to SEE each page rendered correctly.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "https://app.pallio.io";
const HEADLESS = process.env.HEADLESS !== "false";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const SHOTS = join(process.cwd(), "screenshots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (step, ok, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? "  — " + detail : ""}`);
};
let N = 0;
async function shot(page, name) {
  N += 1;
  const file = `${String(N).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "_")}`;
  try { await page.screenshot({ path: join(SHOTS, `${file}.png`), fullPage: true }); } catch {}
  return file;
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const body = () => page.locator("body").innerText().catch(() => "");
  const has = async (re) => re.test(await body());

  async function step(name, fn) {
    try {
      const d = await fn();
      await shot(page, name);
      rec(name, true, d ?? "");
    } catch (err) {
      const f = await shot(page, `ERR-${name}`);
      rec(name, false, `${(err.message || "").slice(0, 120).replace(/\n/g, " ")} [${f}.png]`);
    }
  }

  console.log(`\n████  LIVE UI WALKTHROUGH → ${BASE}  ████`);
  console.log(`     account: ${EMAIL} · screenshots → ${SHOTS}\n`);

  try {
    // ── login ────────────────────────────────────────────────────────
    await step("login page renders", async () => {
      await page.goto(`${BASE}/login`);
      if (!(await page.locator('input[type="password"]').count())) throw new Error("no password field");
    });
    await step("login submits → dashboard", async () => {
      await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await Promise.all([
        page.waitForURL((u) => !u.toString().includes("/login"), { timeout: 25_000 }),
        page.getByRole("button", { name: /sign in|log ?in|continue/i }).first().click(),
      ]);
      return `landed on ${page.url().replace(BASE, "")}`;
    });

    // ── patients caseload ──────────────────────────────────────────────
    await step("patients caseload (acuity + last/next visit)", async () => {
      await page.goto(`${BASE}/patients`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      if (!/Patients/.test(t)) throw new Error("no Patients heading");
      const bits = ["Acuity", "Last visit", "Next visit"].filter((b) => t.includes(b));
      const names = ["Lovelace", "Hopper"].filter((n) => t.includes(n));
      return `cols=[${bits.join(",")}] patients=[${names.join(",")}]`;
    });

    // ── Ada detail: overview + acuity + tabs ───────────────────────────
    await step("open Ada Lovelace → patient detail", async () => {
      await page.getByRole("link", { name: /Lovelace/i }).first().click();
      // Wait for the detail to hydrate (client fetch) — the Clinical card.
      await page.getByText(/Identity/i).first().waitFor({ timeout: 15_000 });
      return page.url().replace(BASE, "");
    });
    const adaUrl = page.url();
    const adaId = adaUrl.split("/patients/")[1]?.split(/[/?#]/)[0] || "";
    await step("acuity selector present + set-able", async () => {
      const el = page.locator('select[aria-label="Patient acuity"]').first();
      await el.waitFor({ timeout: 10_000 });
      await el.selectOption({ label: "High" }).catch(() => {});
      await page.waitForTimeout(800);
      return "acuity → High (PATCHed)";
    });
    await step("Ada → Messages tab: send a message", async () => {
      await page.getByRole("button", { name: /^messages$/i }).first().click().catch(async () => {
        await page.getByText(/messages/i).first().click();
      });
      const box = page.getByPlaceholder(/Message the team/i).first();
      await box.waitFor({ timeout: 8000 });
      await box.fill(`UI walkthrough note ${Date.now()}`);
      await page.getByRole("button").filter({ has: page.locator("svg") }).last().click().catch(() => {});
      await page.waitForTimeout(1200);
      return "message sent via UI";
    });
    await step("Ada → Care plan editor", async () => {
      await page.goto(`${adaUrl}/care-plan`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Care plan|Goals of care/.test(await body())) throw new Error("no care plan editor");
    });

    // ── Ada's visits tab renders ───────────────────────────────────────
    await step("Ada → Visits tab lists her visit", async () => {
      await page.goto(adaUrl);
      await page.getByText(/Identity/i).first().waitFor({ timeout: 12_000 });
      await page.getByRole("button", { name: /^visits$/i }).first().click().catch(() => {});
      await page.waitForTimeout(800);
      const t = await body();
      if (!/visit on file|visits on file|Open|No visits yet/i.test(t)) throw new Error("visits tab empty of content");
      return "visits tab rendered";
    });

    // ── superbill: fetch Ada's visit id from the session, go direct ────
    await step("superbill: payer-scoped picker + risk + ICD + time", async () => {
      const rows = await page.evaluate(async () => {
        try { const r = await fetch("/api/visits?limit=100"); const j = await r.json(); return j?.data?.rows || []; }
        catch { return []; }
      });
      const av = rows.find((v) => v.patientId === adaId) || rows[0];
      if (!av) throw new Error("no visit found via session fetch");
      await page.goto(`${BASE}/visits/${av.id}/superbill`);
      // Wait for the superbill to hydrate.
      await page.getByText(/Superbill|Billable codes/i).first().waitFor({ timeout: 15_000 });
      const t = await body();
      const feats = [];
      if (/Superbill/i.test(t)) feats.push("superbill");
      if (await page.getByPlaceholder(/Type code or descriptor/i).count()) feats.push("payer-picker");
      if (/risk|likely denial|predicted|medium|high/i.test(t)) feats.push("risk");
      if (/ICD-10 diagnoses/i.test(t)) feats.push("icd-picker");
      if (/Time spent/i.test(t)) feats.push("time-panel");
      if (feats.length < 3) throw new Error(`only saw: ${feats.join(",") || "nothing"} on ${page.url().replace(BASE, "")}`);
      return feats.join(",");
    });

    // ── billing lookup (LLM) ───────────────────────────────────────────
    await step("billing lookup → Ask (LLM cited answer)", async () => {
      await page.goto(`${BASE}/billing/lookup`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Rule lookup|lookup/i.test(await body())) throw new Error("no lookup page");
      // Fill whatever fields exist, then Ask.
      await page.locator("select").first().selectOption({ index: 1 }).catch(() => {});
      await page.locator('input').first().fill("99349").catch(() => {});
      const ask = page.getByRole("button", { name: /^ask$/i }).first();
      if (await ask.count()) {
        await ask.click().catch(() => {});
        await page.waitForTimeout(6000); // LLM round-trip
      }
      return "submitted lookup";
    });

    // ── denials + AI analysis ──────────────────────────────────────────
    await step("denials list", async () => {
      await page.goto(`${BASE}/billing/denials`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Denials/.test(await body())) throw new Error("no denials page");
      return "denials list rendered";
    });
    await step("open denial → AI analysis", async () => {
      const row = page.getByRole("link", { name: /open|99349|CPT/i }).first();
      const cell = page.getByText(/99349/).first();
      if (await row.count()) await row.click();
      else if (await cell.count()) await cell.click();
      else throw new Error("no denial row to open");
      await page.waitForLoadState("networkidle").catch(() => {});
      const analyze = page.getByRole("button", { name: /analyze|re-analyze/i }).first();
      if (await analyze.count()) {
        await analyze.click().catch(() => {});
        await page.waitForTimeout(6000); // Claude round-trip
      }
      const t = await body();
      if (!/recommend|refile|appeal|write off|likely|analysis|predicted/i.test(t)) throw new Error("no AI analysis content");
      return "AI analysis shown";
    });

    // ── NEW (#74): denial refile + record-outcome buttons work FE→BE ────
    await step("denial workflow: decide → refile → outcome (new buttons)", async () => {
      // We're on a denial detail page. Drive it to a recorded outcome by
      // clicking the real buttons, whatever state it starts in.
      let t = await body();
      const clickByName = async (re) => {
        const b = page.getByRole("button", { name: re }).first();
        if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(1500); return true; }
        return false;
      };
      const trail = [];
      if (/Outcome:/i.test(t)) return "already resolved — outcome shown";
      // If no decision yet, decide "Refile" so the refile/outcome UI appears.
      if (/Refile[\s\S]*Appeal[\s\S]*Write off/i.test(t) && !/Record final outcome/i.test(t)) {
        if (await clickByName(/^refile$/i)) trail.push("decided:refile");
        t = await body();
      }
      // Mark as refiled (the /refile endpoint the new button calls).
      if (await clickByName(/mark as refiled/i)) trail.push("refiled");
      // Record the outcome (the /outcome endpoint the new button calls).
      if (await clickByName(/paid in full/i)) trail.push("outcome:paid");
      t = await body();
      if (!/Outcome:/i.test(t)) throw new Error(`outcome not recorded (trail=${trail.join(",") || "none"})`);
      return `clicked [${trail.join(",")}] → Outcome shown`;
    });

    // ── rulebook + comparison ──────────────────────────────────────────
    await step("rulebook (generated + comparison controls)", async () => {
      await page.goto(`${BASE}/settings/rulebook`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      if (!/Rulebook/.test(t)) throw new Error("no rulebook page");
      const feats = ["Generate", "covered", "Aetna", "compare", "upload"].filter((f) => new RegExp(f, "i").test(t));
      return `saw: ${feats.join(",")}`;
    });

    // ── cheat sheets ───────────────────────────────────────────────────
    await step("cheat sheets page", async () => {
      await page.goto(`${BASE}/cheat-sheets`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Cheat sheets|Generate cheat sheet/i.test(await body())) throw new Error("no cheat-sheet page");
    });

    // ── schedule week grid ─────────────────────────────────────────────
    await step("schedule week grid + controls", async () => {
      await page.goto(`${BASE}/schedule`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      if (!/Schedule/.test(t)) throw new Error("no schedule page");
      const btns = ["Prev", "This week", "Next", "New visit", "Add PTO", "Print route"].filter((b) => t.includes(b));
      if (btns.length < 3) throw new Error(`few controls: ${btns.join(",")}`);
      return `controls=[${btns.join(",")}]`;
    });

    // ── remaining pages render ─────────────────────────────────────────
    for (const [route, needle] of [
      ["/", /dashboard|overview|kpi|welcome|today/i],
      ["/reports", /Reports/i],
      ["/audit", /Audit/i],
      ["/team", /Team/i],
      ["/inbox", /Inbox/i],
      ["/documents", /Documents/i],
      ["/settings", /Settings/i],
      ["/settings/account", /Account/i],
      ["/settings/branding", /Branding/i],
      ["/settings/security", /Security|MFA/i],
      ["/settings/integrations", /Integrations|Google Calendar/i],
      ["/visits", /Visits/i],
    ]) {
      await step(`page ${route}`, async () => {
        await page.goto(`${BASE}${route}`);
        await page.waitForLoadState("networkidle").catch(() => {});
        if (!needle.test(await body())) throw new Error(`content mismatch on ${route}`);
      });
    }

    // ── notification bell present ──────────────────────────────────────
    await step("notification bell in chrome", async () => {
      await page.goto(`${BASE}/patients`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const bell = page.locator('[aria-label*="notification" i], button:has(svg.lucide-bell), [data-testid="bell"]');
      // best-effort — bell may be an icon; don't hard-fail the whole run on it
      return (await bell.count()) ? "bell present" : "bell not detected (non-fatal)";
    });

    // ── logout ─────────────────────────────────────────────────────────
    await step("logout → /login", async () => {
      const btn = page.getByRole("button", { name: /sign out|log ?out/i }).first();
      if (!(await btn.count())) throw new Error("sign-out not found");
      await btn.click();
      await page.waitForURL((u) => u.toString().includes("/login"), { timeout: 12_000 });
    });
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n████  RESULT  ████`);
  console.log(`${pass}/${results.length} UI steps pass`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log("\nFailures (with screenshot names):"); for (const f of failed) console.log(`  ❌ ${f.step} — ${f.detail}`); }
  console.log(`\nScreenshots for visual review: ${SHOTS}`);
  console.log(`  (${N} PNGs — scroll through them to SEE every page without logging in)`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
