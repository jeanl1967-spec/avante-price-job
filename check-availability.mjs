// Availability check for ONE property and ONE month (started from the hook
// builder's "Check availability" button). Reads StockNetwork's booking site
// live, works out the minimum stay (tries 1, 2, 3, 5 and 7 nights), marks
// every night that can be booked, and saves avail/<ResortID>-<YYYY-MM>.json in
// this repository for the hook builder's calendar. Nothing is reused: each run
// is a fresh live check.
//   RESORT_ID, MONTH (YYYY-MM), REQUEST_ID (from the hook builder), AGENT_ID
import { chromium } from "playwright";
import fs from "fs";
import { execSync } from "child_process";
const env = process.env;
const RID = String(env.RESORT_ID || "").toLowerCase().trim(), MONTH = String(env.MONTH || "").trim();
const AGENT = env.AGENT_ID || "85f88c9f-46bd-4d99-bf0a-1dc2a150ad55";
if (!/^[0-9a-f-]{36}$/.test(RID) || !/^\d{4}-\d{2}$/.test(MONTH)) { console.error("Need RESORT_ID and MONTH (YYYY-MM)."); process.exit(1); }
const [Y, M] = MONTH.split("-").map(Number), DAYS = new Date(Date.UTC(Y, M, 0)).getUTCDate();
const iso = (d) => d.toISOString().slice(0, 10), day = (n) => new Date(Date.UTC(Y, M - 1, n)), plus = (d, n) => new Date(d.getTime() + n * 864e5);
const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

async function check(ctx, ci, nights) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://stock.stocknetwork.co.za/ui/${AGENT}?ResortID=${RID}&CheckInDT=${iso(ci)}&CheckOutDT=${iso(plus(ci, nights))}`, { timeout: 60000, waitUntil: "domcontentloaded" });
    try { await page.waitForFunction(() => document.querySelector(".stock-price, .stock-price-smaller") || /no vacancies/i.test(document.body.innerText), null, { timeout: 40000 }); }
    catch (e) { return { ok: null }; }
    await page.waitForTimeout(500);
    return await page.evaluate(() => {
      const ps = [...document.querySelectorAll(".stock-price, .stock-price-smaller")].filter((e) => !e.classList.contains("strikethrough")).map((e) => parseFloat(e.textContent.replace(/[^\d.]/g, ""))).filter((n) => n > 0);
      const units = [...document.querySelectorAll(".resort-availability-row")].map((r) => +((r.innerText.match(/Avail:\s*(\d+)/) || [0, 0])[1])).reduce((a, b) => a + b, 0);
      return ps.length ? { ok: true, total: Math.min(...ps), units } : { ok: false };
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
  results = minNights ? await pool(starts, 8, (d) => check(ctx, d, minNights)) : results.map(() => ({ ok: false }));
}
await browser.close();
// A night is available if any bookable stay covers it.
const nights = {};
starts.forEach((d, i) => {
  const r = results[i]; if (!r || !minNights) return;
  for (let k = 0; k < minNights; k++) {
    const key = iso(plus(d, k)); if (key.slice(0, 7) !== MONTH) continue;
    if (r.ok) nights[key] = { open: true, perNight: Math.round(r.total / minNights), units: r.units };
    else if (!nights[key] && r.ok === false) nights[key] = { open: false };
  }
});
for (let i = 1; i <= DAYS; i++) { const key = iso(day(i)); if (!nights[key]) nights[key] = { open: false, past: day(i) < today }; }
const out = { resortId: RID, month: MONTH, minNights, checkedAt: new Date().toISOString(), requestId: env.REQUEST_ID || "", nights };
fs.mkdirSync("avail", { recursive: true });
const file = `avail/${RID}-${MONTH}.json`; fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`${Object.values(nights).filter((n) => n.open).length} available nights in ${MONTH}, minimum stay ${minNights || "none found"}.`);
if (!env.NO_PUSH) {
  for (let t = 1; t <= 5; t++) {
    try { execSync(`git add ${file} && git commit -q -m "Availability ${RID.slice(0, 8)} ${MONTH}" && git pull -q --rebase origin HEAD && git push -q origin HEAD`); console.log("Saved", file); break; }
    catch (e) { try { execSync("git rebase --abort"); } catch (e2) {} await new Promise((r) => setTimeout(r, 3000 * t)); }
  }
}
