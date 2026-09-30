// Price job for the Avante hooks site (v2).
// For every hub property it opens StockNetwork's own booking page for a few
// upcoming 2-night stays and keeps the LOWEST price per night, then saves the
// list to the hooks site (POST /api/rates), which fills "from R… per night".
//
// Built to never lose work: prices are saved every SAVE_EVERY properties,
// it stops cleanly before TIME_BUDGET_MIN, and properties priced in the last
// SKIP_DAYS days are skipped — so the next run simply carries on.
//
// Settings (environment variables):
//   HUB_URL, HOOKS_URL, AGENT_ID, RATES_TOKEN (required to save)
//   STAY_STARTS   days ahead for each sample check-in, default "10,31"
//   NIGHTS        nights per sample stay, default 2
//   PARALLEL      pages at once, default 8
//   SHARD/SHARDS  split the list across runners (e.g. 0/3, 1/3, 2/3)
//   SKIP_DAYS     skip properties priced within this many days, default 6
//   TIME_BUDGET_MIN  stop starting new properties after this, default 320
//   SAVE_EVERY    save after this many properties, default 25
//   ONLY_IDS, DRY_RUN=1  for testing
import { chromium } from "playwright";

const env = process.env;
const HUB = (env.HUB_URL || "https://go.avantetravel.co.za").replace(/\/$/, "");
const HOOKS = (env.HOOKS_URL || "https://avante-hooks.netlify.app").replace(/\/$/, "");
const AGENT = env.AGENT_ID || "85f88c9f-46bd-4d99-bf0a-1dc2a150ad55";
const STARTS = (env.STAY_STARTS || "10,31").split(",").map(Number).filter((n) => n > 0);
const NIGHTS = Math.max(1, +env.NIGHTS || 2);
const PARALLEL = Math.max(1, +env.PARALLEL || 8);
const SHARD = +env.SHARD || 0, SHARDS = Math.max(1, +env.SHARDS || 1);
const SKIP_DAYS = env.SKIP_DAYS === undefined ? 6 : +env.SKIP_DAYS;
const BUDGET_MS = (+env.TIME_BUDGET_MIN || 320) * 60000;
const SAVE_EVERY = Math.max(1, +env.SAVE_EVERY || 25);
const started = Date.now();
const iso = (d) => d.toISOString().slice(0, 10);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

async function resortIds() {
  if (env.ONLY_IDS) return env.ONLY_IDS.split(",").map((s) => ({ id: s.trim().toLowerCase(), name: s.trim() }));
  const j = await (await fetch(HUB + "/api/resorts")).json();
  const list = (j.resorts || j || []).map((x) => ({ id: String(x.resortId || x.id || "").toLowerCase(), name: x.name || "" }));
  const seen = new Set();
  return list.filter((x) => /^[0-9a-f-]{36}$/.test(x.id) && !seen.has(x.id) && seen.add(x.id));
}
async function recentlyPriced() {
  if (!SKIP_DAYS || env.ONLY_IDS) return new Set();
  try {
    const j = await (await fetch(HOOKS + "/api/rates")).json();
    const cutoff = Date.now() - SKIP_DAYS * 864e5;
    return new Set(Object.entries(j.rates || {}).filter(([, r]) => r.checkedAt && Date.parse(r.checkedAt) > cutoff).map(([id]) => id));
  } catch (e) { return new Set(); }
}

async function lowestTotal(page, id, ci, co) {
  await page.goto(`https://stock.stocknetwork.co.za/ui/${AGENT}?ResortID=${id}&CheckInDT=${ci}&CheckOutDT=${co}`, { timeout: 45000, waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => document.querySelector(".stock-price, .stock-price-smaller") || /no vacancies/i.test(document.body.innerText), null, { timeout: 25000 });
  } catch (e) { return null; }
  await page.waitForTimeout(500);
  const nums = await page.$$eval(".stock-price, .stock-price-smaller", (els) =>
    els.filter((e) => !e.classList.contains("strikethrough")).map((e) => parseFloat(e.textContent.replace(/[^\d.]/g, ""))).filter((n) => n > 0));
  return nums.length ? Math.min(...nums) : null;
}

let pending = {};
async function save(final) {
  const batch = pending; pending = {};
  const n = Object.keys(batch).length;
  if (!n) return;
  if (env.DRY_RUN) { console.log((final ? "Final" : "Progress") + " batch:", JSON.stringify(batch)); return; }
  try {
    const res = await fetch(HOOKS + "/api/rates", { method: "POST", headers: { "content-type": "application/json", "x-rates-token": env.RATES_TOKEN || "" }, body: JSON.stringify({ rates: batch }) });
    console.log(`Saved ${n} price(s) to the hooks site: ${res.status} ${await res.text()}`);
    if (res.status === 401) { console.error("The RATES_TOKEN secret doesn't match the hooks site. Check it under Settings → Secrets and variables → Actions."); process.exit(1); }
  } catch (e) { console.error("Couldn't save this batch:", e.message); Object.assign(pending, batch); }
}

async function main() {
  const all = await resortIds();
  const mine = all.filter((p) => SHARDS === 1 || hash(p.id) % SHARDS === SHARD);
  const skip = await recentlyPriced();
  const todo = mine.filter((p) => !skip.has(p.id));
  console.log(`${all.length} hub properties · this runner ${mine.length} · already priced this week ${mine.length - todo.length} · to check now ${todo.length}`);
  if (!todo.length) return;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  // Only the prices are needed — skip pictures, fonts and video to load pages faster.
  await ctx.route("**/*", (r) => (["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  let done = 0, priced = 0, sinceSave = 0; const queue = todo.slice();
  async function worker() {
    const page = await ctx.newPage();
    while (queue.length) {
      if (Date.now() - started > BUDGET_MS) { queue.length = 0; console.log("Time budget reached — stopping; the next run carries on from here."); break; }
      const p = queue.shift(); let best = null;
      for (const days of STARTS) {
        const a = new Date(Date.now() + days * 864e5), b = new Date(a.getTime() + NIGHTS * 864e5);
        try {
          const total = await lowestTotal(page, p.id, iso(a), iso(b));
          if (total && (!best || total / NIGHTS < best.perNight)) best = { perNight: total / NIGHTS, total, nights: NIGHTS, checkIn: iso(a) };
        } catch (e) { /* try the next date */ }
      }
      done++;
      if (best) { pending[p.id] = { ...best, checkedAt: new Date().toISOString() }; priced++; }
      console.log(`${done}/${todo.length} ${p.name || p.id}: ${best ? "R" + Math.round(best.perNight) + " per night" : "no price on the sample dates"}`);
      if (++sinceSave >= SAVE_EVERY) { sinceSave = 0; await save(false); }
    }
    await page.close();
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  await save(true);
  await browser.close();
  console.log(`Done: priced ${priced} of ${done} checked (${Math.round((Date.now() - started) / 60000)} min).`);
}
main().catch(async (e) => { console.error(e); await save(true); process.exit(1); });
