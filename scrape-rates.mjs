// Weekly price job for the Avante hooks site.
// For every property in the affiliate hub it opens StockNetwork's own booking
// page for a few upcoming 2-night stays, reads the prices StockNetwork shows,
// and keeps the LOWEST price per night. Then it saves the list to the hooks
// site (POST /api/rates), which fills "from R… per night" on the flyers.
//
// Settings (environment variables):
//   HUB_URL       affiliate hub, default https://go.avantetravel.co.za
//   HOOKS_URL     hooks site,   default https://avante-hooks.netlify.app
//   AGENT_ID      StockNetwork agent id used in booking links
//   RATES_TOKEN   secret shared with the hooks site (required to save)
//   STAY_STARTS   days ahead for each sample check-in, default "10,24,38,52"
//   NIGHTS        nights per sample stay, default 2
//   PARALLEL      pages at once, default 4
//   ONLY_IDS      optional comma list of ResortIDs (for testing)
//   DRY_RUN=1     print the prices, don't save
import { chromium } from "playwright";

const HUB = (process.env.HUB_URL || "https://go.avantetravel.co.za").replace(/\/$/, "");
const HOOKS = (process.env.HOOKS_URL || "https://avante-hooks.netlify.app").replace(/\/$/, "");
const AGENT = process.env.AGENT_ID || "85f88c9f-46bd-4d99-bf0a-1dc2a150ad55";
const STARTS = (process.env.STAY_STARTS || "10,24,38,52").split(",").map(Number).filter((n) => n > 0);
const NIGHTS = Math.max(1, +process.env.NIGHTS || 2);
const PARALLEL = Math.max(1, +process.env.PARALLEL || 4);
const iso = (d) => d.toISOString().slice(0, 10);

async function resortIds() {
  if (process.env.ONLY_IDS) return process.env.ONLY_IDS.split(",").map((s) => ({ id: s.trim(), name: s.trim() }));
  const r = await fetch(HUB + "/api/resorts");
  const j = await r.json();
  const list = (j.resorts || j || []).map((x) => ({ id: String(x.resortId || x.id || "").toLowerCase(), name: x.name || "" }));
  return list.filter((x) => /^[0-9a-f-]{36}$/.test(x.id));
}

// Lowest price StockNetwork shows for one stay (the discounted price when
// there is one), or null when nothing is bookable for those dates.
async function lowestTotal(page, id, ci, co) {
  const url = `https://stock.stocknetwork.co.za/ui/${AGENT}?ResortID=${id}&CheckInDT=${ci}&CheckOutDT=${co}`;
  await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => document.querySelector(".stock-price, .stock-price-smaller") || /no vacancies/i.test(document.body.innerText), null, { timeout: 30000 });
  } catch (e) { return null; }
  await page.waitForTimeout(800);
  const nums = await page.$$eval(".stock-price, .stock-price-smaller", (els) =>
    els.filter((e) => !e.classList.contains("strikethrough")).map((e) => parseFloat(e.textContent.replace(/[^\d.]/g, ""))).filter((n) => n > 0));
  return nums.length ? Math.min(...nums) : null;
}

async function main() {
  const ids = await resortIds();
  console.log(`${ids.length} properties, ${STARTS.length} sample stays of ${NIGHTS} night(s) each`);
  const browser = await chromium.launch();
  const rates = {}; let done = 0;
  const queue = ids.slice();
  async function worker() {
    const page = await browser.newPage();
    while (queue.length) {
      const p = queue.shift(); let best = null;
      for (const days of STARTS) {
        const a = new Date(Date.now() + days * 864e5), b = new Date(a.getTime() + NIGHTS * 864e5);
        try {
          const total = await lowestTotal(page, p.id, iso(a), iso(b));
          if (total && (!best || total / NIGHTS < best.perNight)) best = { perNight: total / NIGHTS, total, nights: NIGHTS, checkIn: iso(a) };
        } catch (e) { /* page failed — try the next date */ }
      }
      if (best) rates[p.id] = { ...best, checkedAt: new Date().toISOString() };
      done++;
      console.log(`${done}/${ids.length} ${p.name || p.id}: ${best ? "R" + Math.round(best.perNight) + " per night" : "no price found"}`);
    }
    await page.close();
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
  await browser.close();
  console.log(`Priced ${Object.keys(rates).length} of ${ids.length}.`);
  if (process.env.DRY_RUN) { console.log(JSON.stringify(rates, null, 1)); return; }
  const res = await fetch(HOOKS + "/api/rates", { method: "POST", headers: { "content-type": "application/json", "x-rates-token": process.env.RATES_TOKEN || "" }, body: JSON.stringify({ rates }) });
  const out = await res.text(); console.log("Saved to the hooks site:", res.status, out);
  if (!res.ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
