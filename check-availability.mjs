// Availability check for ONE property — a two-week window (or a whole month)
// — started from the hook builder's availability grid. Records every UNIT
// TYPE's availability and price per night (like NightsBridge), works out
// the minimum stay (tries 1, 2, 3, 5 and 7 nights), and saves
// avail/<ResortID>-<start>.json in this repository. Each run is a fresh live check.
import { chromium } from "playwright";
import fs from "fs";
import { execSync } from "child_process";
const env = process.env;
const RID = String(env.RESORT_ID || "").toLowerCase().trim(), MONTH = String(env.MONTH || "").trim();
const AGENT = env.AGENT_ID || "85f88c9f-46bd-4d99-bf0a-1dc2a150ad55";
// MONTH is either "YYYY-MM" (whole month) or "YYYY-MM-DD" (14 days from that date).
if (!/^[0-9a-f-]{36}$/.test(RID) || !/^\d{4}-\d{2}(-\d{2})?$/.test(MONTH)) { console.error("Need RESORT_ID and MONTH (YYYY-MM or YYYY-MM-DD)."); process.exit(1); }
const iso = (d) => d.toISOString().slice(0, 10), plus = (d, n) => new Date(d.getTime() + n * 864e5);
const WINDOW = MONTH.length === 10;
const FIRST = new Date(Date.UTC(+MONTH.slice(0, 4), +MONTH.slice(5, 7) - 1, WINDOW ? +MONTH.slice(8, 10) : 1));
const DAYS = WINDOW ? 14 : new Date(Date.UTC(FIRST.getUTCFullYear(), FIRST.getUTCMonth() + 1, 0)).getUTCDate();
const day = (n) => plus(FIRST, n - 1), inRange = (key) => key >= iso(FIRST) && key <= iso(plus(FIRST, DAYS - 1));
const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

async function check(ctx, ci, nights) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://stock.stocknetwork.co.za/ui/${AGENT}?ResortID=${RID}&CheckInDT=${iso(ci)}&CheckOutDT=${iso(plus(ci, nights))}`, { timeout: 60000, waitUntil: "domcontentloaded" });
    try { await page.waitForFunction(() => document.querySelector(".stock-price, .stock-price-smaller") || /no vacancies/i.test(document.body.innerText), null, { timeout: 40000 }); }
    catch (e) { return { ok: null }; }
    await page.waitForTimeout(500);
    return await page.evaluate(() => {
      // One row per unit type: its name, its price for the stay, how many are free.
      const rows = [...document.querySelectorAll(".resort-availability-row")].map((r) => {
        const name = ((r.innerText || "").split("\n").map((t) => t.trim()).find((t) => t.length > 3) || "Unit").slice(0, 120);
        const ps = [...r.querySelectorAll(".stock-price, .stock-price-smaller")].filter((e) => !e.classList.contains("strikethrough")).map((e) => parseFloat(e.textContent.replace(/[^\d.]/g, ""))).filter((n) => n > 0);
        return { name, total: ps.length ? Math.min(...ps) : 0, avail: +((r.innerText.match(/Avail:\s*(\d+)/) || [0, 1])[1]) };
      }).filter((r) => r.total > 0);
      if (!rows.length) {
        const ps = [...document.querySelectorAll(".stock-price, .stock-price-smaller")].filter((e) => !e.classList.contains("strikethrough")).map((e) => parseFloat(e.textContent.replace(/[^\d.]/g, ""))).filter((n) => n > 0);
        if (ps.length) rows.push({ name: "All units", total: Math.min(...ps), avail: 1 });
      }
      return rows.length ? { ok: true, total: Math.min(...rows.map((r) => r.total)), units: rows.reduce((a, r) => a + r.avail, 0), rows } : { ok: false };
    });
  } catch (e) { return { ok: null }; } finally { await page.close(); }
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route("**/*", (r) => (["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
const starts = [...Array(DAYS)].map((_, i) => day(i + 1)).filter((d) => d >= today);
let minNights = 1, results = await pool(starts, 8, (d) => check(ctx, d, 1));
if (!results.some((r) => r && r.ok)) {
  minNights = 0;
  for (const n of [2, 3, 5, 7]) {             // find the shortest stay that can be booked
    const probe = await pool(starts.filter((_, i) => i % 3 === 0).slice(0, 8), 8, (d) => check(ctx, d, n));
    if (probe.some((r) => r && r.ok)) { minNights = n; break; }
  }
  // Stays that start a few days before the window can still cover nights in it.
  if (minNights) { for (let k = 1; k < minNights; k++) { const d = plus(FIRST, -k); if (d >= today) starts.unshift(d); } }
  results = minNights ? await pool(starts, 8, (d) => check(ctx, d, minNights)) : results.map(() => ({ ok: false }));
}
await browser.close();
// A night is available (for the property, and per unit type) if any
// bookable stay covers it; its price is that stay's price per night.
const nights = {}, unitNames = [];
starts.forEach((d, i) => {
  const r = results[i]; if (!r || !minNights) return;
  for (let k = 0; k < minNights; k++) {
    const key = iso(plus(d, k)); if (!inRange(key)) continue;
    const n = nights[key] || (nights[key] = { open: false, units: {} });
    if (r.ok) {
      n.open = true; const pn = Math.round(r.total / minNights); n.perNight = n.perNight ? Math.min(n.perNight, pn) : pn;
      for (const row of r.rows) {
        if (!unitNames.includes(row.name)) unitNames.push(row.name);
        const up = Math.round(row.total / minNights), cur = n.units[row.name];
        if (!cur || up < cur.perNight) n.units[row.name] = { perNight: up, avail: row.avail };
      }
    }
  }
});
for (let i = 1; i <= DAYS; i++) { const key = iso(day(i)); if (!nights[key]) nights[key] = { open: false, units: {}, past: day(i) < today }; }
const out = { resortId: RID, month: MONTH, start: iso(FIRST), days: DAYS, minNights, unitNames, checkedAt: new Date().toISOString(), requestId: env.REQUEST_ID || "", nights };
fs.mkdirSync("avail", { recursive: true });
const file = `avail/${RID}-${MONTH}.json`; fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`${Object.values(nights).filter((n) => n.open).length} available nights in ${MONTH}, minimum stay ${minNights || "none found"}.`);
if (!env.NO_PUSH) {
  for (let t = 1; t <= 5; t++) {
    try { execSync(`git add ${file} && git commit -q -m "Availability ${RID.slice(0, 8)} ${MONTH}" && git pull -q --rebase origin HEAD && git push -q origin HEAD`); console.log("Saved", file); break; }
    catch (e) { try { execSync("git rebase --abort"); } catch (e2) {} await new Promise((r) => setTimeout(r, 3000 * t)); }
  }
}
